import * as cluster from "cluster";
import * as EventEmitter from "events";

import * as dbug from "debug";
import * as jwt from "jwt-simple";
import * as WebSocket from "ws";

import config = require("./config");
import logger = require("./logger");
import MessageType = require("./messagetype");
import { packer } from "./packer";
import { IMessage, numberOrString } from "./types";

const dbug1 = dbug("vp:connection");
function debug(msg: string) {
  dbug1((cluster.worker ? `worker ${cluster.worker.id} ` : "") + msg);
}

export default class Connection extends EventEmitter {
  public deviceId: string;
  public key: string;

  private clientId: numberOrString;
  private userId: string;  // Decoded user ID for PONG responses
  private socket: WebSocket;
  private timestamp: number;

  constructor(key: string, socket: WebSocket, deviceId: string, clientId: numberOrString) {
    super();

    this.clientId = clientId;
    this.deviceId = deviceId;
    this.key = key;
    this.socket = socket;
    this.timestamp = Date.now();

    // Decode JWT once to get clean user ID for PONG responses
    try {
      const decoded: any = jwt.decode(String(clientId), config.secretKey);
      logger.info(`[Connection Constructor] JWT decoded result: ${JSON.stringify(decoded)} | type: ${typeof decoded}`);
      
      // The JWT payload is directly the userId string (like "TELENET_81*14946*0011")
      // not an object with claims
      if (typeof decoded === "string") {
        this.userId = decoded;
        logger.info(`[Connection Constructor] userId from JWT string: ${this.userId}`);
      } else if (typeof decoded === "object" && decoded !== null) {
        // Fallback: check for claim fields if it's an object
        const claimUserId = decoded.uid || decoded.user_id || decoded.TELENET_userId || decoded.userId || decoded.sub || decoded.id || null;
        if (claimUserId) {
          this.userId = String(claimUserId);
          logger.info(`[Connection Constructor] userId from JWT object claim: ${this.userId}`);
        } else {
          this.userId = String(clientId);
          logger.warn(`[Connection Constructor] JWT is object but no userId claim found, using clientId`);
        }
      } else {
        this.userId = String(clientId);
        logger.warn(`[Connection Constructor] JWT decode returned unexpected type, using clientId`);
      }
      
      logger.info(`[Connection Constructor] Final userId: ${this.userId}`);
    } catch (err) {
      // If JWT decode fails, use clientId as-is
      this.userId = String(clientId);
      logger.warn(`[Connection Constructor] Could not decode JWT, using clientId as-is: ${err.message}`);
    }

    socket.addListener("close", this.handleSocketClose);
    socket.addListener("error", this.handleSocketError);
    socket.addListener("message", this.handleSocketMessage);
    socket.addListener("ping", this.handleSocketPing);
    socket.addListener("pong", this.handleSocketPong);
  }

  public ping(this: Connection) {
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        const rawPayload = `voiceping:${this.clientId}`;
        let payloadBuf = Buffer.from(rawPayload);
        if (payloadBuf.length > 100) { // control frames must be < 126 bytes
          logger.warn(`PING payload too large (${payloadBuf.length}B); truncating for id:${this.clientId}`);
          payloadBuf = payloadBuf.subarray(0, 100);
        }
        logger.info(`PING send -> id:${this.clientId} device:${this.deviceId} state:${this.socket.readyState} payloadLen:${payloadBuf.length}`);
        this.socket.ping(payloadBuf, false, true);
      } catch (exception) {
        debug(`id ${this.clientId} key ${this.key}` +
              ` PING ERR ${JSON.stringify(exception)}` +
              ` device ${this.deviceId}`);
      }
    }
  }

  public send(this: Connection, data: Buffer, msg?: IMessage) {
    if (msg && (msg.messageType === MessageType.LOGIN_DUPLICATED || msg.messageType === MessageType.CONNECTION_ACK)) {
      debug(`id ${this.clientId} SEND readyState: ${this.socket.readyState}, msg: ${JSON.stringify(msg)}`);
    }
    if (this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(data);
        } catch (exception) {
          debug(`id ${this.clientId} key ${this.key}` +
                ` SEND ERR ${JSON.stringify(exception)}` +
                ` device ${this.deviceId}`);
        }
    }
  }

  public message(this: Connection, msg: IMessage) {
    debug(`id ${this.clientId} SEND_MESSAGE ${JSON.stringify(msg)}`);
    packer.pack(msg, (err, packed) => {
      if (err) {
        debug(`id ${this.clientId} key ${this.key}` +
              ` PACK ERR ${err} ${JSON.stringify(msg)}` +
              ` device ${this.deviceId}`);
        return;
      }
      this.send(packed, msg);
    });
  }

  public close(this: Connection) {
    logger.info(`id: ${this.clientId} key: ${this.key} BEFORE CLOSE readyState: ${this.socket.readyState}`);
    this.socket.close();
  }

  // (WEB)SOCKET (WS) EVENT HANDLERS

  private handleSocketClose = (code, reason) => {
    debug(`id ${this.clientId} key ${this.key}` +
          ` handleSocketClose code ${code} reason ${reason}` +
          ` device ${this.deviceId}`);

    this.socket.removeListener("close", this.handleSocketClose);
    this.socket.removeListener("error", this.handleSocketError);
    this.socket.removeListener("message", this.handleSocketMessage);
    this.socket.removeListener("ping", this.handleSocketPing);
    this.socket.removeListener("pong", this.handleSocketPong);

    this.emit("close", this);
  }

  private handleSocketError = (reason, code) => {
    debug(`id ${this.clientId} key ${this.key}` +
          ` handleSocketError code ${code} reason ${reason}` +
          ` device ${this.deviceId}`);
  }

  private handleSocketMessage = (data: Buffer) => {
    debug(`*************************************`);
    debug(`id ${this.clientId} key ${this.key}` +
              ` handleSocketMessage RAW data: ${data.toString()}` +
              ` device ${this.deviceId}` +
              ` socketState ${this.socket.readyState}`);
    packer.unpack(data, (err: Error, msg: IMessage) => {
      if (err) {
        debug(`id ${this.clientId} key ${this.key}` +
              ` UNPACK ERR ${err} ${JSON.stringify(msg)}` +
              ` device ${this.deviceId}`);
        return;
      }
      debug(`id ${this.clientId} key ${this.key}` +
          ` handleSocketMessage device ${this.deviceId}` +
          ` socketState ${this.socket.readyState}` +
          ` msg: ${JSON.stringify(msg)}`);

      this.emit("message", msg);
    });
  }

  private handleSocketPing = (data: Buffer) => {
    logger.info('------------Inside socket ping handler........', data.toString());
    this.timestamp = Date.now();
    
    const payloadLen = data ? data.length : 0;
    logger.info(`PING recv <- userId:${this.userId} device:${this.deviceId} payloadLen:${payloadLen} state:${this.socket.readyState}`);
    
    // Respond with PONG to client's PING
    // Send back the decoded user ID (e.g., "TELENET_81*14946*0013")
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        // Always send the decoded user ID in PONG
        const pongPayload = Buffer.from(this.userId);
        logger.info('pong payload........', pongPayload.toString());
        this.socket.pong(pongPayload);
        logger.info(`[PONG sent] -> userId:${this.userId} device:${this.deviceId} payload:"${this.userId}" (${pongPayload.length}B)`);
      } catch (err) {
        logger.error(`Failed to send PONG to userId ${this.userId}: ${err}`);
      }
    }
  }

  private handleSocketPong = (data: Buffer) => {
    this.timestamp = Date.now();
    let payload;
    if (data instanceof Buffer) { payload = data.toString(); }
    debug(`id ${this.clientId} key ${this.key}` +
          ` handleSocketPong ${payload}` +
          ` device ${this.deviceId}`);
    logger.info(`PONG recv <- id:${this.clientId} device:${this.deviceId} payloadLen:${data ? data.length : 0} state:${this.socket.readyState}`);
    this.emit("pong", payload);
  }
}
