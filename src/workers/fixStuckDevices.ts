/**
 * fixStuckDevices.ts — ONE-TIME migration. Run ONCE after deploying the final backend.
 *
 * What it fixes (all caused by the OLD code erasing tokens):
 *   1. fcmToken === "__UNINSTALLED__"  → ""                 (legacy garbage value)
 *   2. status "uninstalled" + seen in last N days
 *        → offline/token_missing (token was erased) or offline/no_heartbeat (token present)
 *        dead markers cleared. On the app's next call the backend returns resyncToken=true,
 *        the app pushes its token, and the device comes back online by itself.
 *   3. status offline/token_dead but token is EMPTY → offline/token_missing
 *        (old code erased the token when marking token_dead; under the new model an empty
 *         token is "missing", not "dead" — and the sweep must never touch these)
 *   4. status offline/token_dead with a token but no fcmTokenDeadAt (marked by old code)
 *        → stamp fcmTokenDeadAt = unreachableSince (or now), deadCount = 1
 *        so the new retry / sweep logic has the data it needs
 *
 * Idempotent — safe to run more than once.
 *
 * Usage (pick one):
 *   a) In server bootstrap, guarded by env:
 *        if (process.env.RUN_FCM_MIGRATION === "true") await fixStuckDevices();
 *   b) Standalone: ts-node src/workers/fixStuckDevices.ts   (after connecting mongoose)
 *
 * Env: FCM_MIGRATION_RECOVERY_DAYS (default 30) — how far back "seen recently" reaches for step 2.
 */

import logger from "../logger/logger";
import Device from "../models/Device";

const TAG = "fixStuckDevices";
const RECOVERY_DAYS = (() => {
  const v = Number(process.env.FCM_MIGRATION_RECOVERY_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 30;
})();

export interface MigrationReport {
  markerCleaned: number;
  uninstalledReset: number;
  emptyTokenDeadFixed: number;
  deadStamped: number;
}

export async function fixStuckDevices(): Promise<MigrationReport> {
  const now = Date.now();
  const recoveryCutoff = now - RECOVERY_DAYS * 24 * 60 * 60 * 1000;
  const report: MigrationReport = { markerCleaned: 0, uninstalledReset: 0, emptyTokenDeadFixed: 0, deadStamped: 0 };

  logger.info(`${TAG}: starting`, { recoveryDays: RECOVERY_DAYS });

  /* 1. legacy marker → "" */
  try {
    const r = await Device.updateMany(
      { fcmToken: "__UNINSTALLED__" },
      { $set: { fcmToken: "" } },
    );
    report.markerCleaned = r.modifiedCount;
  } catch (e: any) {
    logger.error(`${TAG}: step 1 failed`, { error: e?.message });
  }

  /* 2. wrongly-uninstalled (seen recently) → offline, dead markers cleared */
  try {
    // token empty → token_missing
    const r1 = await Device.updateMany(
      {
        fcmStatus: "uninstalled",
        "lastSeen.at": { $gte: recoveryCutoff },
        fcmToken: { $in: ["", null] },
      },
      {
        $set: {
          fcmStatus: "offline",
          unreachableReason: "token_missing",
          unreachableSince: now,
          fcmTokenDeadAt: null,
          fcmTokenDeadCount: 0,
          fcmLastError: "reset_by_migration",
        },
      },
    );
    // token present → no_heartbeat (heartbeat will ping it; success = online, UNREGISTERED = token_dead)
    // fcmTokenDeadAt: null → only docs uninstalled by the OLD code (new code always stamps deadAt first),
    // so re-running this migration later never undoes a legitimate new-code uninstall.
    const r2 = await Device.updateMany(
      {
        fcmStatus: "uninstalled",
        "lastSeen.at": { $gte: recoveryCutoff },
        fcmToken: { $nin: ["", null] },
        fcmTokenDeadAt: null,
      },
      {
        $set: {
          fcmStatus: "offline",
          unreachableReason: "no_heartbeat",
          unreachableSince: now,
          fcmTokenDeadAt: null,
          fcmTokenDeadCount: 0,
          fcmLastError: "reset_by_migration",
        },
      },
    );
    report.uninstalledReset = r1.modifiedCount + r2.modifiedCount;
  } catch (e: any) {
    logger.error(`${TAG}: step 2 failed`, { error: e?.message });
  }

  /* 3. offline/token_dead with EMPTY token → token_missing */
  try {
    const r = await Device.updateMany(
      {
        fcmStatus: "offline",
        unreachableReason: "token_dead",
        fcmToken: { $in: ["", null] },
      },
      {
        $set: {
          unreachableReason: "token_missing",
          fcmTokenDeadAt: null,
          fcmTokenDeadCount: 0,
        },
      },
    );
    report.emptyTokenDeadFixed = r.modifiedCount;
  } catch (e: any) {
    logger.error(`${TAG}: step 3 failed`, { error: e?.message });
  }

  /* 4. offline/token_dead with a token but no deadAt → stamp it */
  try {
    const docs = await Device.find({
      fcmStatus: "offline",
      unreachableReason: "token_dead",
      fcmToken: { $nin: ["", null] },
      fcmTokenDeadAt: null,
    })
      .select("deviceId unreachableSince")
      .lean();

    for (const d of docs as any[]) {
      const since = Number(d.unreachableSince || 0) || now;
      const r = await Device.updateOne(
        { deviceId: d.deviceId, fcmTokenDeadAt: null },
        { $set: { fcmTokenDeadAt: since, fcmTokenDeadCount: 1 } },
      );
      if (r.modifiedCount > 0) report.deadStamped++;
    }
  } catch (e: any) {
    logger.error(`${TAG}: step 4 failed`, { error: e?.message });
  }

  logger.info(`${TAG}: done`, report);
  return report;
}

export default fixStuckDevices;
