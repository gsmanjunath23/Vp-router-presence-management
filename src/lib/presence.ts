import * as cluster from "cluster";
import * as dbug from "debug";
import * as redis from "redis";

import config = require("./config");
import { Keys } from "./keys";
import logger = require("./logger");
import { numberOrString } from "./types";

// Import DynamoDB manager
// tslint:disable-next-line:no-var-requires
const dynamodbModule = require("./dynamodb");
const dynamodbManager = dynamodbModule.dynamodbManager || dynamodbModule.default;

const dbug1 = dbug("vp:presence");
function debug(msg: string) {
  dbug1((cluster.worker ? `worker ${cluster.worker.id} ` : "") + msg);
}

const PRESENCE_TTL = config.presence ? config.presence.ttl : 60;
const PRESENCE_ENABLED = config.presence ? config.presence.enabled : true;

// Redis clients
const clientOptions: any = {};
if (config.redis.password) {
  clientOptions.auth_pass = config.redis.password;
}

const client = redis.createClient(config.redis.port, config.redis.host, clientOptions);
const subscriber = redis.createClient(config.redis.port, config.redis.host, clientOptions);
const keyspaceSubscriber = redis.createClient(config.redis.port, config.redis.host, clientOptions);

client.on("error", (err) => {
  logger.error("Presence Redis client error:", err);
});

subscriber.on("error", (err) => {
  logger.error("Presence Redis subscriber error:", err);
});

keyspaceSubscriber.on("error", (err) => {
  logger.error("Presence Redis keyspace subscriber error:", err);
});

export interface IPresenceStatus {
  userId: numberOrString;
  status: "online" | "offline";
  lastSeen?: number;
  deviceId?: string;
  metadata?: any;
}

export interface IPresenceSnapshot {
  users: IPresenceStatus[];
  timestamp: number;
  totalOnline: number;
}

export interface IPresenceUpdate {
  type: "presence_update";
  userId: numberOrString;
  status: "online" | "offline";
  timestamp: number;
  lastSeen?: number;
  deviceId?: string;
}

type PresenceChangeCallback = (update: IPresenceUpdate) => void;

// tslint:disable:member-ordering
class PresenceManager {
  private changeCallbacks: PresenceChangeCallback[] = [];
  private keyspaceNotificationsEnabled: boolean = false;

  constructor() {
    if (PRESENCE_ENABLED) {
      this.initializeRedis();
    }
  }

  /**
   * Initialize Redis Pub/Sub and keyspace notifications
   */
  private initializeRedis() {
    // Subscribe to presence channels
    subscriber.subscribe("presence:online");
    subscriber.subscribe("presence:offline");
    subscriber.subscribe("presence:updates");

    subscriber.on("message", (channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        debug(`Received Pub/Sub message on ${channel}: ${message}`);
        this.handlePresenceChange(data);
      } catch (err) {
        logger.error(`Error parsing presence message: ${err}`);
      }
    });

    // Enable keyspace notifications for TTL expiry
    this.enableKeyspaceNotifications();

    logger.info("Presence Manager initialized with TTL=" + PRESENCE_TTL);
  }

  /**
   * Enable Redis keyspace notifications for expired keys
   */
  private enableKeyspaceNotifications() {
    client.config("SET", "notify-keyspace-events", "Ex", (err, reply) => {
      if (err) {
        logger.error("Failed to enable keyspace notifications:", err);
        logger.info("Presence offline detection via TTL expiry will not work - enable manually");
      } else {
        this.keyspaceNotificationsEnabled = true;
        logger.info("Redis keyspace notifications enabled for presence TTL expiry");

        // Subscribe to expired events
        keyspaceSubscriber.subscribe("__keyevent@0__:expired");

        keyspaceSubscriber.on("message", (channel: string, expiredKey: string) => {
          if (expiredKey.startsWith("presence:user:")) {
            const userId = expiredKey.split(":")[2];
            debug(`TTL expired for user: ${userId}`);
            this.handleTTLExpiry(userId);
          }
        });
      }
    });
  }

  /**
   * Set user as online with TTL
   */
  public setUserOnline(
    userId: numberOrString,
    metadata?: { deviceId?: string; role?: string; [key: string]: any },
    callback?: (err: Error, success: boolean) => void
  ): void {
    if (!PRESENCE_ENABLED) {
      if (callback) { return callback(null, false); }
      return;
    }

    const presenceKey = Keys.forPresence(userId);
    const metaKey = Keys.forPresenceMeta(userId);
    const timestamp = Date.now();

    const multi = client.multi();
    multi.set(presenceKey, "1", "EX", PRESENCE_TTL);
    multi.hset(metaKey, "status", "online");
    multi.hset(metaKey, "lastSeen", timestamp.toString());

    if (metadata) {
      if (metadata.deviceId) {
        multi.hset(metaKey, "deviceId", metadata.deviceId);
      }
      if (metadata.role) {
        multi.hset(metaKey, "role", metadata.role);
      }
    }

    multi.exec((err, replies) => {
      if (err) {
        logger.error(`setUserOnline error for user ${userId}:`, err);
        if (callback) { return callback(err, false); }
        return;
      }

      debug(`User ${userId} set online with TTL=${PRESENCE_TTL}s`);

      // Publish to other servers
      this.publishPresenceChange(userId, "online", { timestamp, ...metadata });

      // Update DynamoDB appOnlineStatus (replaces AWS IoT MQTT)
      if (dynamodbManager.isEnabled()) {
        dynamodbManager.updateUserStatus(userId, "online", (dynamoErr, success) => {
          if (dynamoErr) {
            logger.error(`DynamoDB update failed for user ${userId}:`, dynamoErr);
          } else {
            debug(`DynamoDB updated: user ${userId} online`);
          }
        });
      }

      if (callback) { return callback(null, true); }
    });
  }

  /**
   * Refresh user's heartbeat (extend TTL)
   */
  public refreshHeartbeat(
    userId: numberOrString,
    callback?: (err: Error, success: boolean) => void
  ): void {
    if (!PRESENCE_ENABLED) {
      if (callback) { return callback(null, false); }
      return;
    }

    const presenceKey = Keys.forPresence(userId);
    const metaKey = Keys.forPresenceMeta(userId);
    const timestamp = Date.now();

    const multi = client.multi();
    multi.expire(presenceKey, PRESENCE_TTL);
    multi.hset(metaKey, "lastSeen", timestamp.toString());

    multi.exec((err, replies) => {
      if (err) {
        logger.error(`refreshHeartbeat error for user ${userId}:`, err);
        if (callback) { return callback(err, false); }
        return;
      }

      debug(`Heartbeat refreshed for user ${userId}, TTL reset to ${PRESENCE_TTL}s`);

      if (callback) { return callback(null, true); }
    });
  }

  /**
   * Set user as offline
   */
  public setUserOffline(
    userId: numberOrString,
    callback?: (err: Error, success: boolean) => void
  ): void {
    if (!PRESENCE_ENABLED) {
      if (callback) { return callback(null, false); }
      return;
    }

    const presenceKey = Keys.forPresence(userId);
    const metaKey = Keys.forPresenceMeta(userId);
    const timestamp = Date.now();

    const multi = client.multi();
    multi.del(presenceKey);
    multi.hset(metaKey, "status", "offline");
    multi.hset(metaKey, "lastSeen", timestamp.toString());

    multi.exec((err, replies) => {
      if (err) {
        logger.error(`setUserOffline error for user ${userId}:`, err);
        if (callback) { return callback(err, false); }
        return;
      }

      debug(`User ${userId} set offline`);

      // Publish to other servers
      this.publishPresenceChange(userId, "offline", { timestamp });

      // Update DynamoDB appOnlineStatus (replaces AWS IoT MQTT)
      if (dynamodbManager.isEnabled()) {
        dynamodbManager.updateUserStatus(userId, "offline", (dynamoErr, success) => {
          if (dynamoErr) {
            logger.error(`DynamoDB update failed for user ${userId}:`, dynamoErr);
          } else {
            debug(`DynamoDB updated: user ${userId} offline`);
          }
        });
      }

      if (callback) { return callback(null, true); }
    });
  }

  /**
   * Get list of all online users
   */
  public getOnlineUsers(callback: (err: Error, users: IPresenceStatus[]) => void): void {
    if (!PRESENCE_ENABLED) {
      return callback(null, []);
    }

    client.keys("presence:user:*", (err, keys) => {
      if (err) {
        logger.error("getOnlineUsers error:", err);
        return callback(err, []);
      }

      if (!keys || keys.length === 0) {
        return callback(null, []);
      }

      // Extract userIds from keys
      const userIds = keys.map((key) => key.split(":")[2]);

      // Get metadata for each user
      this.getBulkPresenceStatus(userIds, callback);
    });
  }

  /**
   * Get presence status for multiple users (BULK API)
   */
  public getBulkPresenceStatus(
    userIds: numberOrString[],
    callback: (err: Error, users: IPresenceStatus[]) => void
  ): void {
    if (!PRESENCE_ENABLED) {
      return callback(null, []);
    }

    if (!userIds || userIds.length === 0) {
      return callback(null, []);
    }

    const multi = client.multi();

    // Check if each user's presence key exists
    userIds.forEach((userId) => {
      multi.exists(Keys.forPresence(userId));
    });

    // Get metadata for all users
    userIds.forEach((userId) => {
      multi.hgetall(Keys.forPresenceMeta(userId));
    });

    multi.exec((err, replies) => {
      if (err) {
        logger.error("getBulkPresenceStatus error:", err);
        return callback(err, []);
      }

      const users: IPresenceStatus[] = [];
      const halfLength = replies.length / 2;

      for (let i = 0; i < halfLength; i++) {
        const exists = replies[i] === 1;
        const metadata = replies[halfLength + i];
        const userId = userIds[i];

        if (exists && metadata) {
          // User is online with metadata
          users.push({
            deviceId: metadata.deviceId,
            lastSeen: metadata.lastSeen ? Number(metadata.lastSeen) : Date.now(),
            metadata,
            status: "online",
            userId
          });
        } else if (metadata && metadata.lastSeen) {
          // User is offline but has metadata
          users.push({
            deviceId: metadata.deviceId,
            lastSeen: Number(metadata.lastSeen),
            metadata,
            status: "offline",
            userId
          });
        } else {
          // User has no presence data
          users.push({
            lastSeen: 0,
            status: "offline",
            userId
          });
        }
      }

      const onlineCount = users.filter((u) => u.status === "online").length;
      debug(`Bulk presence check for ${userIds.length} users: ${onlineCount} online`);

      callback(null, users);
    });
  }

  /**
   * Get presence snapshot for web clients
   */
  public getPresenceSnapshot(callback: (err: Error, snapshot: IPresenceSnapshot) => void): void {
    this.getOnlineUsers((err, users) => {
      if (err) {
        return callback(err, null);
      }

      const snapshot: IPresenceSnapshot = {
        timestamp: Date.now(),
        totalOnline: users.filter((u) => u.status === "online").length,
        users
      };

      callback(null, snapshot);
    });
  }

  /**
   * Publish presence change to Redis Pub/Sub
   */
  private publishPresenceChange(
    userId: numberOrString,
    status: "online" | "offline",
    metadata?: any
  ): void {
    const update: IPresenceUpdate = {
      status,
      timestamp: Date.now(),
      type: "presence_update",
      userId,
      ...metadata
    };

    const channel = status === "online" ? "presence:online" : "presence:offline";
    const message = JSON.stringify(update);

    client.publish(channel, message, (err) => {
      if (err) {
        logger.error(`Failed to publish presence change: ${err}`);
      } else {
        debug(`Published ${status} for user ${userId} to ${channel}`);
      }
    });

    // Also publish to general updates channel
    client.publish("presence:updates", message);
  }

  /**
   * Handle TTL expiry (user went offline due to no heartbeat)
   */
  private handleTTLExpiry(userId: numberOrString): void {
    debug(`TTL expiry detected for user ${userId} - marking offline`);
    this.setUserOffline(userId);
  }

  /**
   * Handle presence change from Pub/Sub
   */
  private handlePresenceChange(data: IPresenceUpdate): void {
    // Notify all registered callbacks (for broadcasting to clients)
    this.changeCallbacks.forEach((callback) => {
      try {
        callback(data);
      } catch (err) {
        logger.error("Error in presence change callback:", err);
      }
    });
  }

  /**
   * Subscribe to presence changes
   */
  public onPresenceChange(callback: PresenceChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Check if presence system is enabled
   */
  public isEnabled(): boolean {
    return PRESENCE_ENABLED;
  }

  /**
   * Get presence TTL value
   */
  public getTTL(): number {
    return PRESENCE_TTL;
  }
}

export const presenceManager = new PresenceManager();
export default presenceManager;
