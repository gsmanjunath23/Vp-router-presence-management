import * as cluster from "cluster";
import * as winston from "winston";

const logger = new winston.Logger({
  level: "info", // IMPORTANT: ensures info logs are printed
  transports: [
    new winston.transports.Console({
      formatter: (options: any) => {
        const worker = cluster.worker ? `worker ${cluster.worker.id} ` : "";
        const timestamp = new Date().toISOString();
        return `${timestamp} - ${options.level}: ${worker}${options.message || ""}`;
      }
    })
  ],
});

export = logger;
