/* tslint:disable */
require("dotenv").config();

import * as http from "http";
import * as config from "./lib/config";

const VoicePing = require("./lib/voiceping");
const Package = require("../package");
const presenceManager = require("./lib/presence").default;

(() => {
  const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`Welcome to VoicePing Router ${Package.version}`);
      } else if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: Package.version }));
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    } else if (req.method === "POST") {
      if (req.url === "/api/presence/status") {
        // Bulk presence status check API
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            const userIds = data.userIds;

            if (!Array.isArray(userIds)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "userIds must be an array" }));
              return;
            }

            presenceManager.getBulkPresenceStatus(userIds, (err, users) => {
              if (err) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Failed to get presence status" }));
                return;
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                success: true,
                users,
                timestamp: Date.now()
              }));
            });
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    } else {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
    }
  });
  server.listen(config.app.port, () => new VoicePing.Server({ server }));
})();
