import logger from "../logger/logger";
import Device from "../models/Device";
import wsService from "../services/wsService";
import { sendPing } from "../services/fcmService";
import {
  markDeviceUninstalled,
  markDeviceOffline,
  normalizeToken,
  getUninstallPolicy,
} from "../services/deviceService";

/**
 * heartbeatWorker.ts — FINAL
 *
 * Runs every 5 min. For every device with lastSeen > 0 and not uninstalled:
 *
 *   no token          → make sure status is offline/token_missing; nothing to ping
 *   token DEAD        → retry on a schedule (a success un-marks it; a failure bumps the count)
 *                         · device seen since our last attempt → every 30 min  (app is alive, verify quickly)
 *                         · silent                              → every 6 h
 *                         · silent > 7 d                        → every 24 h
 *   token healthy:
 *     seen ≤ 15 min   → responsive, no ping
 *     15 min – 2 h    → idle: ping after 30 min idle, cooldown 1 h
 *     > 2 h           → unreachable: mark offline/no_heartbeat, ping cooldown 3 h
 *     > 7 d           → long tail: ping cooldown 24 h  (never fully give up — a late
 *                        UNREGISTERED is how we eventually learn about a real uninstall)
 *
 * Cooldown is measured from fcmLastAttemptAt in the DB (any send, incl. admin commands) —
 * no in-memory map, so a restart or a second instance can't cause ping storms.
 *
 * Sweep: offline/token_dead devices meeting the uninstall policy (getUninstallPolicy) → uninstalled.
 * The policy is re-checked atomically inside markDeviceUninstalled().
 */

const INTERVAL_MS = 5 * 60 * 1000;

const IDLE_THRESHOLD_MS        = 15 * 60 * 1000;
const UNREACHABLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;   // == ONLINE_WINDOW_MS in deviceService
const LONG_TAIL_AFTER_MS       = 7 * 24 * 60 * 60 * 1000;

// healthy-token ping cadence
const PING_AFTER_IDLE_MS            = 30 * 60 * 1000;
const PING_COOLDOWN_IDLE_MS         = 60 * 60 * 1000;
const PING_COOLDOWN_UNREACHABLE_MS  = 3 * 60 * 60 * 1000;
const PING_COOLDOWN_LONG_TAIL_MS    = 24 * 60 * 60 * 1000;

// dead-token retry cadence
const DEAD_RETRY_ALIVE_MS     = 30 * 60 * 1000;
const DEAD_RETRY_SILENT_MS    = 6 * 60 * 60 * 1000;
const DEAD_RETRY_LONG_TAIL_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function start() {
  if (timer) {
    logger.warn("heartbeatWorker: already running");
    return;
  }
  timer = setInterval(() => {
    run().catch((err) => logger.error("heartbeatWorker error", err));
  }, INTERVAL_MS);
  setTimeout(() => {
    run().catch((err) => logger.error("heartbeatWorker initial run failed", err));
  }, 30_000);
  const policy = getUninstallPolicy(); // first read — dotenv is loaded by now (start() runs after listen)
  logger.info("heartbeatWorker: started", {
    intervalMs: INTERVAL_MS,
    uninstallAuto: policy.auto,
    uninstallAfterDays: policy.afterMs / 86400000,
  });
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logger.info("heartbeatWorker: stopped");
}

async function safePing(deviceId: string, why: string, extra: Record<string, any>) {
  try {
    const r = await sendPing(deviceId);
    logger.info(`heartbeatWorker: ping (${why})`, { deviceId, ok: r.success, error: r.error, ...extra });
    return true;
  } catch (e: any) {
    logger.warn(`heartbeatWorker: ping threw (${why})`, { deviceId, error: e?.message || e });
    return false;
  }
}

/* ═══════════════════════════════════════════
   SWEEP → uninstalled (policy-driven, reversible)
   ═══════════════════════════════════════════ */

async function runSweep() {
  const policy = getUninstallPolicy();
  if (!policy.auto) return;
  try {
    const cutoff = Date.now() - policy.afterMs;

    const candidates = await Device.find({
      fcmStatus: "offline",
      unreachableReason: "token_dead",
      fcmTokenDeadAt: { $ne: null, $lte: cutoff },
      fcmTokenDeadCount: { $gte: policy.minDeadCount },
      "lastSeen.at": { $lte: cutoff },
    })
      .select("deviceId lastSeen.at fcmTokenDeadAt fcmTokenDeadCount")
      .lean();

    if (candidates.length === 0) return;
    logger.info("heartbeatWorker: sweep candidates", { count: candidates.length });

    for (const d of candidates) {
      const deviceId = String((d as any).deviceId || "").trim();
      if (!deviceId) continue;
      try {
        // markDeviceUninstalled re-checks every condition atomically — if the app
        // came back between our find() and this call, it's a no-op.
        const didChange = await markDeviceUninstalled(deviceId);
        if (didChange) {
          try { wsService.broadcastAdminEvent("device:uninstalled", { deviceId }, { deviceId }); } catch (_) {}
          logger.info("heartbeatWorker: promoted to uninstalled", {
            deviceId,
            silentDays: Math.round((Date.now() - Number((d as any).lastSeen?.at || 0)) / 86400000),
            deadDays: Math.round((Date.now() - Number((d as any).fcmTokenDeadAt || 0)) / 86400000),
            deadCount: Number((d as any).fcmTokenDeadCount || 0),
          });
        }
      } catch (e: any) {
        logger.warn("heartbeatWorker: sweep markDeviceUninstalled failed", { deviceId, error: e?.message });
      }
    }
  } catch (err) {
    logger.error("heartbeatWorker: runSweep error", err);
  }
}

/* ═══════════════════════════════════════════
   MAIN LOOP
   ═══════════════════════════════════════════ */

async function run() {
  if (running) {
    logger.warn("heartbeatWorker: previous run still in progress — skipping this tick");
    return;
  }
  running = true;
  try {
    const now = Date.now();

    const devices = await Device.find({
      "lastSeen.at": { $gt: 0 },
      fcmStatus: { $ne: "uninstalled" },
    })
      .select("deviceId lastSeen fcmToken fcmTokenDeadAt fcmTokenDeadCount fcmLastAttemptAt fcmStatus unreachableReason")
      .lean();

    if (!devices || devices.length === 0) {
      logger.debug("heartbeatWorker: no devices");
      await runSweep();
      return;
    }

    const c = {
      total: devices.length,
      responsive: 0, idle: 0, unreachable: 0,
      noToken: 0, deadToken: 0,
      pinged: 0, deadRetried: 0,
      skippedCooldown: 0,
    };

    for (const d of devices as any[]) {
      const deviceId = String(d.deviceId || "").trim();
      if (!deviceId) continue;

      const lastSeenAt   = Number(d.lastSeen?.at || 0);
      const silence      = now - lastSeenAt;
      const token        = normalizeToken(d.fcmToken);
      const deadAt       = d.fcmTokenDeadAt ?? null;
      const lastAttempt  = Number(d.fcmLastAttemptAt || 0);
      const sinceAttempt = now - lastAttempt;
      const status       = String(d.fcmStatus || "online");

      /* ── no token ── */
      if (!token) {
        c.noToken++;
        await markDeviceOffline(deviceId, "token_missing"); // conditional no-op if already
        continue;
      }

      /* ── dead token: retry on schedule ── */
      if (deadAt) {
        c.deadToken++;
        const seenSinceAttempt = lastSeenAt > lastAttempt;
        const interval = seenSinceAttempt
          ? DEAD_RETRY_ALIVE_MS
          : silence > LONG_TAIL_AFTER_MS ? DEAD_RETRY_LONG_TAIL_MS : DEAD_RETRY_SILENT_MS;

        if (sinceAttempt >= interval) {
          if (await safePing(deviceId, "dead-token retry", {
            deadCount: Number(d.fcmTokenDeadCount || 0),
            deadForHrs: Math.round((now - deadAt) / 3600000),
            seenSinceAttempt,
          })) c.deadRetried++;
        } else {
          c.skippedCooldown++;
        }
        continue;
      }

      /* ── healthy token ── */
      if (silence <= IDLE_THRESHOLD_MS) {
        c.responsive++;
        continue;
      }

      if (silence <= UNREACHABLE_THRESHOLD_MS) {
        c.idle++;
        if (silence >= PING_AFTER_IDLE_MS && sinceAttempt >= PING_COOLDOWN_IDLE_MS) {
          if (await safePing(deviceId, "idle", { idleMin: Math.round(silence / 60000) })) c.pinged++;
        } else {
          c.skippedCooldown++;
        }
        continue;
      }

      // > 2h silent
      c.unreachable++;
      if (status === "online") {
        await markDeviceOffline(deviceId, "no_heartbeat");
      }
      const cooldown = silence > LONG_TAIL_AFTER_MS ? PING_COOLDOWN_LONG_TAIL_MS : PING_COOLDOWN_UNREACHABLE_MS;
      if (sinceAttempt >= cooldown) {
        if (await safePing(deviceId, silence > LONG_TAIL_AFTER_MS ? "long-tail" : "unreachable", {
          silentHrs: Math.round(silence / 3600000),
        })) c.pinged++;
      } else {
        c.skippedCooldown++;
      }

      try {
        wsService.notifyDeviceLastSeen(deviceId, {
          at: lastSeenAt,
          action: d.lastSeen?.action || "",
          battery: d.lastSeen?.battery ?? -1,
        });
      } catch { /* ignore */ }
    }

    await runSweep();

    logger.info("heartbeatWorker: summary", c);

    if (c.noToken > 0 && Math.round((c.noToken / c.total) * 100) > 20) {
      logger.warn("heartbeatWorker: high % of devices without FCM token", {
        noToken: c.noToken, total: c.total, percent: Math.round((c.noToken / c.total) * 100),
      });
    }
    if (c.deadToken > 0 && Math.round((c.deadToken / c.total) * 100) > 20) {
      logger.warn("heartbeatWorker: high % of devices with DEAD token — check app onNewToken sync", {
        deadToken: c.deadToken, total: c.total, percent: Math.round((c.deadToken / c.total) * 100),
      });
    }
  } catch (err) {
    logger.error("heartbeatWorker: run error", err);
  } finally {
    running = false;
  }
}
