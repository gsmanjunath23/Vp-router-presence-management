import * as cluster from "cluster";

import * as dbug from "debug";
import * as _ from "lodash";
import * as Q from "q";
import * as WebSocket from "ws";

import ChannelType = require("./channeltype");
import Client, { IClients } from "./client";
import config = require("./config");

import logger = require("./logger");
import MessageType = require("./messagetype");
import { packer } from "./packer";
import presenceManager from "./presence";
import Redis = require("./redis");
import States from "./states";
import { IMessage, numberOrString } from "./types";

const WORKER_NUMBER = cluster.worker ? cluster.worker.id : "-";
const dbug1 = dbug("vp:router");
function debug(msg: string) {
  dbug1((cluster.worker ? `worker ${cluster.worker.id} ` : "") + msg);
}

export interface IServer {
  sendMessageToUser: (mesage: IMessage) => void;
  sendMessageToGroup: (message: IMessage) => void;
  hasActiveConnection: (userId: numberOrString) => boolean;
}
interface IConnection {
  token: string;
  deviceId: string;
  key: string;
}

// class Server implements IServer {
class Server implements IServer {

  private clients: IClients = {};
  private sockets = {};
  private deviceTokens = {};
  private wss = null;
  private verify = null;
  private webClients = []; // Track web clients for presence broadcasting

  constructor(options) {
    const opts = {
      memo: null,
      port: 9000,
      server: null,
      verify: this.verifyClient,
      ...options
    };

    if (opts.verify) { this.verify = opts.verify; }

    States.setMemored(opts.memo);
    States.periodicInspect();
    if (WORKER_NUMBER.toString() === "1") {
        Redis.periodicClean();
    }

    // Initialize presence management
    this.initializePresence();

    // WSS & WS SETUP
    if (opts.server) {
      this.wss = new WebSocket.Server({ server: opts.server, verifyClient: this.verify.bind(this) });
      logger.info("WebSocket.Server is created");
    } else {
      this.wss = new WebSocket.Server({ port: opts.port, verifyClient: this.verify.bind(this) });
      logger.info(`WebSocket.Server is created at port ${opts.port}`);
    }

    this.wss.on("connection", this.handleWssConnection.bind(this));
  }

  // PRESENCE MANAGEMENT
  // tslint:disable:member-ordering

  private initializePresence() {
    if (!presenceManager.isEnabled()) {
      logger.info("Presence management is disabled");
      return;
    }

    logger.info("Initializing presence management");

    // Subscribe to presence changes from Redis Pub/Sub
    presenceManager.onPresenceChange((update) => {
      this.broadcastPresenceUpdate(update);
    });
  }

  private broadcastPresenceUpdate(update: any) {
    // Broadcast presence update to all web clients
    const msg: IMessage = {
      channelType: ChannelType.GROUP,
      fromId: 0,
      messageType: MessageType.PRESENCE_UPDATE,
      payload: update,
      toId: "broadcast"
    };

    packer.pack(msg, (err, packed) => {
      if (err) {
        logger.error("Failed to pack presence update:", err);
        return;
      }

      // Send to all web clients
      this.webClients.forEach((webClient: any) => {
        try {
          if (webClient.socket && webClient.socket.readyState === WebSocket.OPEN) {
            webClient.socket.send(packed);
          }
        } catch (error) {
          logger.error("Error sending presence update to web client:", error);
        }
      });

      debug(`Broadcasted presence update to ${this.webClients.length} web clients`);
    });
  }

  private sendPresenceSnapshot(socket: WebSocket, userId: numberOrString) {
    presenceManager.getPresenceSnapshot((err, snapshot) => {
      if (err) {
        logger.error("Failed to get presence snapshot:", err);
        return;
      }

      const msg: IMessage = {
        channelType: ChannelType.GROUP,
        fromId: 0,
        messageType: MessageType.PRESENCE_SNAPSHOT,
        payload: snapshot,
        toId: userId
      };

      packer.pack(msg, (err2, packed) => {
        if (err2) {
          logger.error("Failed to pack presence snapshot:", err2);
          return;
        }

        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(packed);
            logger.info(`Sent presence snapshot to user ${userId}: ${snapshot.totalOnline} users online`);
          }
        } catch (error) {
          logger.error("Error sending presence snapshot:", error);
        }
      });
    });
  }

  // IServer Implementation

  public sendMessageToUser(this: Server, msg: IMessage) {
    packer.pack(msg, (err, packed) => {
      const client = this.clients[msg.toId];
      if (!client) {
        if (msg.messageType === MessageType.AUDIO) {
          debug(`sendMessageToUser type AUDIO NOT-FOUND id ${msg.toId} ${JSON.stringify(msg)}`);
        } else {
          debug(`sendMessageToUser type NON-AUDIO NOT-FOUND id ${msg.toId} ${JSON.stringify(msg)}`);
        }
        return;
      }
      client.send(packed);
    });
  }

  public sendMessageToGroup(this: Server, msg: IMessage) {
    logger.info(`sendMessageToGroup from: ${msg.fromId} to: ${msg.toId} messageType: ${msg.messageType}`);
    packer.pack(msg, (err, packed) => {
      this.sendDataFromUserToGroup(packed, msg.fromId, msg.toId);
    });
  }

  public hasActiveConnection(this: Server, userId: numberOrString): boolean {
    return !!this.clients[userId];
  }

  private handleClientUnregister = (client: Client) => {
    const clientId = client.id;
    if (!this.clients[clientId]) { return; }

    // Clean up any active call states when user disconnects unexpectedly
    States.removeCurrentMessageOfUser(clientId, (err, success) => {
      if (err) {
        logger.error(`Failed to remove current message for user ${clientId}:`, err);
      } else {
        debug(`Cleaned up active call state for disconnected user ${clientId}`);
      }
    });

    // Check if user was in any group calls and clean up group state
    States.getGroupsOfUser(clientId, (err, groupIds) => {
      if (groupIds && groupIds.length > 0) {
        groupIds.forEach((groupId) => {
          States.getCurrentMessageOfGroup(groupId, (groupErr, currentMsg) => {
            if (currentMsg && currentMsg.fromId.toString() === clientId.toString()) {
              // This user was the one talking in the group - clear the group busy state
              States.removeCurrentMessageOfGroup(groupId, (removeErr, removeSuccess) => {
                if (!removeErr) {
                  debug(`Cleaned up group ${groupId} call state - user ${clientId} disconnected`);
                }
              });
            }
          });
        });
      }
    });

    // Mark user offline when they disconnect (mobile clients only)
    const clientData = (client as any);
    if (clientData.role === "mobile") {
      presenceManager.setUserOffline(clientId, (err) => {
        if (err) {
          logger.error(`Failed to mark user ${clientId} offline:`, err);
        }
      });
    } else if (clientData.role === "web") {
      // Remove from web clients list
      this.webClients = this.webClients.filter((wc: any) => wc.userId !== clientId);
    }

    client.removeListener("message", this.handleClientMessage);
    client.removeListener("unregister", this.handleClientUnregister);
    delete this.clients[clientId];
    delete this.sockets[clientId];
    logger.info(`UNREGISTERED id ${clientId} clients ${Object.keys(this.clients).length}` +
                ` sockets ${Object.keys(this.sockets).length} wss ${this.wss.clients.size}`);
  }

  private handleClientMessage = (msg: IMessage, client: Client) => {
    logger.info(`handleClientMessage id ${msg.fromId} to ${msg.toId} messageType ${msg.messageType}`);
    
    // Handle heartbeat messages
    if (msg.messageType === MessageType.HEARTBEAT) {
      logger.info(`[HEARTBEAT DETECTED] User ${msg.fromId} sent MessageType.HEARTBEAT (30)`);
      this.handleHeartbeat(msg, client);
      return;
    }
    
    if (msg.channelType === ChannelType.GROUP) {
      if (msg.messageType === MessageType.CONNECTION) {
        this.handleConnectionMessage(msg);
      } else {
        this.sendMessageToGroup(msg);
      }
    } else {
      this.sendMessageToUser(msg);
    }
  }

  private handleHeartbeat(msg: IMessage, client: Client) {
    presenceManager.refreshHeartbeat(msg.fromId, (err, success) => {
      if (err) {
        logger.error(`Heartbeat refresh failed for user ${msg.fromId}:`, err);
      } else {
        debug(`Heartbeat received from user ${msg.fromId}`);
      }
    });
  }

  private registerClient(this: Server, socket: WebSocket, id: numberOrString,
                         key: string, deviceId: string, user: any) {
    let client = this.clients[id];
    if (!client) {
      client = new Client(id, user, this);
      client.addListener("message", this.handleClientMessage);
      client.addListener("unregister", this.handleClientUnregister);
      this.clients[id] = client;
    }

    client.registerSocket(socket, key, deviceId);
    this.sockets[id] = socket;

    // Store client role for presence management
    const role = user.role || "mobile"; // Default to mobile if not specified
    (client as any).role = role;

    // Handle presence based on client role
    if (role === "web" || role === "dashboard") {
      // Web client: Add to broadcast list and send snapshot
      this.webClients.push({ userId: id, socket, role });
      this.sendPresenceSnapshot(socket, id);
      logger.info(`WEB CLIENT registered: ${id}`);
    } else {
      // Mobile client: Set online in Redis with TTL
      presenceManager.setUserOnline(id, { deviceId, role }, (err) => {
        if (err) {
          logger.error(`Failed to set user ${id} online:`, err);
        }
      });
      logger.info(`MOBILE CLIENT registered: ${id}`);
    }

    // tslint:disable-next-line:max-line-length
    logger.info(`REGISTERED id ${client.id} clients ${Object.keys(this.clients).length} readyState ${socket.readyState} ` +
                ` sockets ${Object.keys(this.sockets).length} wss ${this.wss.clients.size}`);
  }

  private getConnectionFromHeaders(headers, log: boolean = false): IConnection {
    let protocols = headers["sec-websocket-protocol"];
    if (protocols) { protocols = protocols.split(", "); }
    const token0 = protocols ? protocols[0] : null;
    const deviceId0  = protocols ? protocols[1] : null;
    const token = headers.token || headers.voicepingtoken || token0;
    const deviceId = headers.device_id || headers.deviceid || deviceId0 || token;
    const connection = { token, deviceId, key: headers["sec-websocket-key"] };
    return connection;
  }

  private getUserFromToken(token) {
    const deferred = Q.defer();
    deferred.resolve({ uid: token });
    return deferred.promise;
  }

  /**
   * Websocket client verification
   *
   * @param { object } info
   * @param { function } verified
   * @private
   *
   */
  private verifyClient(this: Server, info, verified) {
    const connection = this.getConnectionFromHeaders(info.req.headers, true);
    const token = connection.token;
    if (!token) { return verified(false, 401, "Unauthorized"); }
    this.getUserFromToken(token)
      .then((user) => {
        return verified(user, 200, "Authorized");
      }).catch((err) => {
        logger.error(`verifyClient getUserFromToken ERR ${err}`);
        return verified(false, 401, "Unauthorized User");
      });
  }

  private handleWssConnection(this: Server, ws: WebSocket, req) {
    const connection = this.getConnectionFromHeaders(req.headers);
    const token = connection.token;
    if (!token) { return; }

    // If deviceId exists on redis, send duplicate login.
    this.getUserFromToken(token)
      .then((user) => {
        logger.info(`handleWssConnection after getUserFromToken. user: ${JSON.stringify(user)}`);
        const deviceId = connection.deviceId;
        const userId = user.uid;
        const key = connection.key;

        this.registerClient(ws, userId, key, deviceId, user);
      }).catch((err) => {
        logger.error(`handleWssConnection getUserFromToken ERR ${err}`);
      });

  }

  /**
   * Direct message to a destination
   *
   * @param { data } data
   * @param { number } userId
   * @private
   *
   */
  private sendDataToUser(this: Server, data: Buffer, userId: numberOrString) {
    if (this.clients.hasOwnProperty(userId)) {
      const client = this.clients[userId];
      client.send(data);
    } else {
      // debug(`sendDataToUser NOT-FOUND id ${userId}`);
    }
  }

  /**
   * Broadcast a message / data to a channel
   *
   * @param { data } data
   * @param { number } userId
   * @param { number } groupId
   * @private
   *
   */
  private sendDataFromUserToGroup(
    this: Server,
    data: Buffer, userId: numberOrString,
    groupId: numberOrString, echo: boolean = false
  ) {
    States.getUsersInsideGroup(groupId, (err, userIds) => {
      if (err) {
        logger.error(`States.getUsersInsideGroup id ${userId} groupId ${groupId} ERR ${err}`);
        return;
      }
      if (!userIds || !(userIds instanceof Array) || userIds.length <= 0) {
        logger.info(`States.getUsersInsideGroup EMPTY id ${userId} groupId ${groupId}`);
        return;
      }
      for (const recipientId of userIds) {
        if (!echo && recipientId.toString() === userId.toString()) { continue; }
        this.sendDataToUser(data, recipientId);
      }
    });
  }

  /**
   *
   * Connection message handler
   *
   * @param { number } userId
   * @param { object } ws
   * @param { data } payload
   * @private
   *
   */
  private handleConnectionMessage = (msg: IMessage): void => {
    logger.info(`handleConnectionMessage id ${msg.fromId} payload ${msg.payload}`);
    /* Buffer should be device token for voip push notification
       device token needs to be either registered or unregistered
       when a new device is connected */
    if (msg.payload) {
      const deviceToken = msg.payload.toString();
      Redis.getGroupsOfUser(msg.fromId, (err, groupIds) => {
        logger.info(`Redis.getGroupsOfUser id ${msg.fromId} groupIds ${groupIds}`);
      });
    }
  }
}

module.exports = Server;
