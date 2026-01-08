import * as cluster from "cluster";
import { createLogger, format, transports } from "winston";

const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => {
      const worker = cluster.worker ? `worker ${cluster.worker.id} ` : "";
      return `${timestamp} - ${level}: ${worker}${message}`;
    })
  ),
  level: "info", // IMPORTANT: ensures info logs are printed
  transports: [
    new transports.Console()
  ],
});

export = logger;
