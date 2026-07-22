import http from "http";
import https from "https";
import fs from "fs";
import app from "./app";
import config from "./config";
import logger from "./logger/logger";
import mongo from "./db/mongo";
import wsService from "./services/wsService";
import { startWorkers, stopWorkers } from "./workers";
import { getFirebaseApp } from "./services/firebaseAdmin";

const port = config.port || 3000;

async function start() {
  try {
    // 1) connect to DB
    const m: any = mongo;
    if (typeof m.connectToMongo === "function") {
      await m.connectToMongo();
    } else if (typeof m.connect === "function") {
      await m.connect();
    } else {
      throw new Error("mongo module does not export a connect function");
    }

    // 2) initialize Firebase Admin on startup
    // fail fast if firebase-admin.json path or credentials are wrong
    try {
      getFirebaseApp();
      logger.info("Firebase Admin initialized successfully");
    } catch (err: any) {
      logger.error("Firebase Admin initialization failed", err);
      throw err;
    }

    // 3) create server (http or https depending on config.useTls)
    let server: http.Server | https.Server;
    if (config.useTls && config.tls.keyPath && config.tls.certPath) {
      try {
        const key = fs.readFileSync(config.tls.keyPath);
        const cert = fs.readFileSync(config.tls.certPath);
        server = https.createServer({ key, cert }, app);
        logger.info("Server: starting in HTTPS mode");
      } catch (err: any) {
        logger.error("Server: failed to read TLS files, falling back to HTTP", err);
        server = http.createServer(app);
      }
    } else {
      server = http.createServer(app);
    }

    // 4) init websocket service
    wsService.init(server, config.wsPath);

    // 5) start listening
    server.listen(port, async () => {
      logger.info(`Server listening on port ${port} (env=${config.env})`);

      try {
        await startWorkers();
        logger.info("Workers started successfully");
      } catch (err: any) {
        logger.error("Failed to start workers", err);
      }
    });

    const shutdown = async (signal: string) => {
      try {
        logger.info(`Received ${signal} - shutting down gracefully`);

        server.close(async (err) => {
          if (err) {
            logger.error("Server close error", err);
          }

          try {
            await stopWorkers();
            logger.info("Workers stopped successfully");
          } catch (e) {
            logger.warn("stopWorkers failed", e);
          }

          try {
            await wsService.shutdown();
          } catch (e) {
            logger.warn("wsService.shutdown failed", e);
          }

          try {
            if (typeof m.closeMongo === "function") {
              await m.closeMongo();
            } else if (typeof m.close === "function") {
              await m.close();
            } else if (typeof m.disconnect === "function") {
              await m.disconnect();
            } else {
              logger.warn("mongo module has no close/closeMongo/disconnect function");
            }
          } catch (e) {
            logger.warn("closeMongo failed", e);
          }

          logger.info("Shutdown complete - exiting process");
          process.exit(0);
        });

        setTimeout(() => {
          logger.warn("Forcing exit after timeout");
          process.exit(1);
        }, 30_000).unref();
      } catch (e) {
        logger.error("Shutdown handler error", e);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    process.on("uncaughtException", (err) => {
      logger.error("Uncaught exception", err);
      try {
        shutdown("uncaughtException");
      } catch {
        process.exit(1);
      }
    });

    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled promise rejection", reason);
    });
  } catch (err: any) {
    logger.error("Failed to start server:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

export default { start };