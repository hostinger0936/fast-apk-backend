// File: src/workers/restartCoreWorker.ts
import logger from "../logger/logger";

/**
 * restartCoreWorker.ts
 *
 * POST-MIGRATION:
 *   This worker is DISABLED.
 *
 *   Old behavior: periodically send restart_core to all devices via WS/FCM.
 *   New behavior: not needed. App wakes up via FCM on-demand.
 *   Kept as a stub for interface compatibility with workers/index.ts.
 */

let timer: NodeJS.Timeout | null = null;

export function start() {
  logger.info("restartCoreWorker: disabled (not needed in push-based architecture)");
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logger.info("restartCoreWorker: stopped");
}