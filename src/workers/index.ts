// server/workers/index.ts
import logger from "../logger/logger";
import * as cleanupWorker from "./cleanupWorker";
import * as heartbeatWorker from "./heartbeatWorker";
import * as restartCoreWorker from "./restartCoreWorker";
import { fixStuckDevices } from "./fixStuckDevices";

let started = false;

export async function startWorkers() {
  if (started) {
    logger.warn("workers: already started");
    return;
  }
  started = true;
  logger.info("workers: starting all workers");

  // One-time FCM migration (repairs damage left by the old token-erasing code).
  // Runs only when RUN_FCM_MIGRATION=true — set it, restart once, confirm the
  // "fixStuckDevices: done {...}" log line, then remove the env and restart.
  // Must run BEFORE the heartbeat's first sweep, hence here.
  if (String(process.env.RUN_FCM_MIGRATION || "").toLowerCase() === "true") {
    try {
      const report = await fixStuckDevices();
      logger.info("workers: FCM migration report", report);
    } catch (e) {
      logger.error("workers: FCM migration failed", e);
    }
  }

  try {
    cleanupWorker.start();
    heartbeatWorker.start();
    // start restartCore worker
    restartCoreWorker.start();
  } catch (e) {
    logger.error("workers: failed to start some workers", e);
  }
}

export async function stopWorkers() {
  if (!started) {
    logger.warn("workers: not started");
    return;
  }
  started = false;
  logger.info("workers: stopping all workers");

  try {
    // stop in reverse / any order
    await Promise.all([
      cleanupWorker.stop(),
      heartbeatWorker.stop(),
      restartCoreWorker.stop(),
    ]);
  } catch (e) {
    logger.warn("workers: stopWorkers error", e);
  }
}
