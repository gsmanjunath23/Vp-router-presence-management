/**
 * DynamoDB Integration for Presence Management
 * 
 * This replaces the AWS IoT MQTT system for updating user online/offline status
 * Updates the appOnlineStatus field in DynamoDB Users table
 * 
 * Note: Uses AWS SDK v2 for Node.js 8.16.0 compatibility
 */

import * as cluster from "cluster";
import * as dbug from "debug";
import config = require("./config");
import logger = require("./logger");
import { numberOrString } from "./types";

const dbug1 = dbug("vp:dynamodb");
function debug(msg: string) {
  dbug1((cluster.worker ? `worker ${cluster.worker.id} ` : "") + msg);
}

// Import AWS SDK v2 (will be installed)
// tslint:disable:no-var-requires
let DynamoDB: any;

// Try to load AWS SDK if available
try {
  const AWS = require("aws-sdk");
  DynamoDB = AWS.DynamoDB;
} catch (err) {
  logger.error("AWS SDK not installed. DynamoDB updates will be disabled.");
  logger.error("Install with: npm install aws-sdk");
}
// tslint:enable:no-var-requires

export interface IDynamoDBConfig {
  enabled: boolean;
  region: string;
  tablesEnv: {
    dev: string;
    test: string;
    stage: string;
    prod: string;
  };
}

// tslint:disable:member-ordering
class DynamoDBManager {
  private client: any;
  private enabled: boolean;
  private currentEnv: string;

  constructor() {
    const dynamoConfig: IDynamoDBConfig = config.dynamodb || {
      enabled: false,
      region: "ap-northeast-1",
      tablesEnv: {
        dev: "Users-Dev",
        test: "Users-Test",
        stage: "Users-Stage",
        prod: "Users-Prod"
      }
    };

    this.enabled = dynamoConfig.enabled && !!DynamoDB;
    this.currentEnv = process.env.NODE_ENV || "dev";

    if (this.enabled) {
      this.client = new DynamoDB({ region: dynamoConfig.region });
      logger.info(`DynamoDB integration enabled for environment: ${this.currentEnv}`);
    } else {
      logger.info("DynamoDB integration is disabled");
    }
  }

  /**
   * Update user's appOnlineStatus in DynamoDB
   * This replaces the Lambda updateStatus function
   */
  public async updateUserStatus(
    userId: numberOrString,
    status: "online" | "offline",
    callback?: (err: Error | null, success: boolean) => void
  ): Promise<void> {
    if (!this.enabled) {
      if (callback) {
        return callback(null, false);
      }
      return;
    }

    try {
      const tableName = this.getTableName();

      // Build update parameters (matching Lambda's model.update)
      const params = {
        TableName: tableName,
        Key: {
          pk: { S: "users" },
          id: { S: String(userId) }
        },
        UpdateExpression: "SET #appOnlineStatus = :appOnlineStatus, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#appOnlineStatus": "appOnlineStatus"
        },
        ExpressionAttributeValues: {
          ":appOnlineStatus": { S: status },
          ":updatedAt": { S: new Date().toISOString() }
        }
      };

      this.client.updateItem(params, (err: Error, data: any) => {
        if (err) {
          logger.error(`DynamoDB update failed for user ${userId}:`, err);
          if (callback) {
            callback(err, false);
          }
          return;
        }

        logger.info(`DynamoDB: Updated user ${userId} appOnlineStatus to ${status}`);
        debug(`Successfully updated DynamoDB for user ${userId}`);

        if (callback) {
          callback(null, true);
        }
      });
    } catch (err) {
      logger.error(`DynamoDB update failed for user ${userId}:`, err);

      if (callback) {
        callback(err as Error, false);
      }
    }
  }

  /**
   * Update user status by pttNo (mobile identifier)
   * Finds user by pttNo first, then updates status
   */
  public async updateUserStatusByPttNo(
    pttNo: numberOrString,
    status: "online" | "offline",
    callback?: (err: Error | null, success: boolean) => void
  ): Promise<void> {
    if (!this.enabled) {
      if (callback) {
        return callback(null, false);
      }
      return;
    }

    try {
      // First, get user ID from pttNo
      const userId = await this.getUserIdByPttNo(pttNo);

      if (!userId) {
        logger.error(`Cannot update status: User not found for pttNo ${pttNo}`);
        if (callback) {
          return callback(new Error("User not found"), false);
        }
        return;
      }

      // Update status using user ID
      await this.updateUserStatus(userId, status, callback);
    } catch (err) {
      logger.error(`Error updating status by pttNo ${pttNo}:`, err);
      if (callback) {
        callback(err as Error, false);
      }
    }
  }

  /**
   * Check if DynamoDB integration is enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get current environment
   */
  public getEnvironment(): string {
    return this.currentEnv;
  }

  /**
   * Get the table name for current environment
   */
  private getTableName(): string {
    const dynamoConfig: IDynamoDBConfig = config.dynamodb;
    const env = this.currentEnv.toLowerCase();

    // Map environment names
    const envMap = {
      development: "dev",
      dev: "dev",
      qa: "test",
      test: "test",
      testing: "test",
      stage: "stage",
      staging: "stage",
      production: "prod",
      prod: "prod"
    };

    const mappedEnv = envMap[env] || "dev";
    return dynamoConfig.tablesEnv[mappedEnv] || dynamoConfig.tablesEnv.dev;
  }

  /**
   * Get user ID from pttNo (equivalent to Lambda's getUserInfo)
   */
  private async getUserIdByPttNo(pttNo: numberOrString): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const tableName = this.getTableName();

      const params = {
        TableName: tableName,
        IndexName: "pttNo-index",
        KeyConditionExpression: "pttNo = :pttNo",
        FilterExpression: "isDeleted = :isDeleted",
        ExpressionAttributeValues: {
          ":pttNo": { S: String(pttNo) },
          ":isDeleted": { BOOL: false }
        },
        ProjectionExpression: "id, pttNo",
        Limit: 1 // We only need the first match
      };

      return new Promise((resolve, reject) => {
        this.client.query(params, (err: Error, data: any) => {
          if (err) {
            reject(err);
            return;
          }

          if (data.Items && data.Items.length > 0) {
            const user = data.Items[0];
            const userId = user.id ? user.id.S : null;
            debug(`Found user ID ${userId} for pttNo ${pttNo}`);
            resolve(userId);
          } else {
            debug(`No user found for pttNo ${pttNo}`);
            resolve(null);
          }
        });
      });
    } catch (err) {
      logger.error(`Error querying user by pttNo ${pttNo}:`, err);
      return null;
    }
  }
}

export const dynamodbManager = new DynamoDBManager();
export default dynamodbManager;
