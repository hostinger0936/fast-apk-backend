// server/workers/index.ts
import logger from "../logger/logger";
import * as cleanupWorker from "./cleanupWorker";
import * as heartbeatWorker from "./heartbeatWorker";
import * as restartCoreWorker from "./restartCoreWorker";

let started = false;

export async function startWorkers() {
  if (started) {
    logger.warn("workers: already started");
    return;
  }
  started = true;
  logger.info("workers: starting all workers");

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
