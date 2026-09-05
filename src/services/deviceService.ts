import Device from "../models/Device";
import logger from "../logger/logger";

/**
 * deviceService.ts — FINAL
 *
 * ═══════════════════════════════════════════════════════════════
 * THE FIVE RULES (read these before touching anything below)
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. fcmToken is NEVER erased by the backend.
 *    FCM errors MARK the token dead (fcmTokenDeadAt); they never write fcmToken = "".
 *    The only writers of fcmToken are updateFcmToken() (app sent a token) and deleteDevice().
 *
 * 2. updateFcmToken() is the ONLY function that writes fcmToken.
 *    Routes / other services must call it — never $set fcmToken directly.
 *
 * 3. Every state write is CONDITIONAL (compare-and-swap on the token / status it was
 *    computed from). A concurrent update from the app can never be clobbered.
 *
 * 4. Any app→backend HTTP call is proof-of-life and flows through applyAliveStatus(),
 *    which also reverses "uninstalled".
 *
 * 5. "uninstalled" is a slow, reversible heuristic — it requires a dead token, N days of
 *    silence AND ≥2 Firebase rejections, and can be disabled entirely (UNINSTALL_AUTO=false).
 */

const TAG = "deviceService";

/* ═══════════════════════════════════════════
   CONSTANTS / CONFIG
   ═══════════════════════════════════════════ */

const UNINSTALLED_MARKER = "__UNINSTALLED__";   // legacy garbage value — treated as "no token"
const MIN_TOKEN_LENGTH   = 50;                  // real FCM tokens are ~140–180 chars; this only rejects garbage
const RETIRED_TOKENS_MAX = 5;

/** lastSeen within this window + healthy token → "online". Matches routes' computeReachability (>2h = unreachable). */
export const ONLINE_WINDOW_MS = 2 * 60 * 60 * 1000;

function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function envBool(name: string, def: boolean): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return def;
  return !["false", "0", "no", "off"].includes(v);
}

/**
 * Auto-uninstall policy. Override via env:
 *   UNINSTALL_AUTO=false            → never auto-mark uninstalled (admin sees offline/token_dead + days)
 *   UNINSTALL_AFTER_DAYS=7          → token dead AND silent for this many days
 *   UNINSTALL_MIN_DEAD_COUNT=2      → Firebase must have rejected the token at least this many times
 */
export interface UninstallPolicy { auto: boolean; afterMs: number; minDeadCount: number }

// Read LAZILY on first use, not at module load: in this codebase deviceService is evaluated
// (via app.ts → routes → devices.ts) BEFORE config.ts runs dotenv.config(), so a module-level
// read would silently ignore .env and always use the defaults.
let _policy: UninstallPolicy | null = null;
export function getUninstallPolicy(): UninstallPolicy {
  if (_policy) return _policy;
  _policy = {
    auto: envBool("UNINSTALL_AUTO", true),
    afterMs: envNum("UNINSTALL_AFTER_DAYS", 7) * 24 * 60 * 60 * 1000,
    minDeadCount: envNum("UNINSTALL_MIN_DEAD_COUNT", 2),
  };
  logger.info(`${TAG}: uninstall policy`, {
    auto: _policy.auto,
    afterDays: _policy.afterMs / 86400000,
    minDeadCount: _policy.minDeadCount,
  });
  return _policy;
}

/* ═══════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════ */

export type UnreachableReason = "token_dead" | "token_missing" | "no_heartbeat";
export type TokenStatus = "ok" | "dead" | "stale" | "invalid";

export interface TokenUpdateResult {
  ok: boolean;             // false only for invalid format
  replaced: boolean;       // true if a new token was stored
  tokenStatus: TokenStatus;
  forceRefresh: boolean;   // app should deleteToken()+getToken() (same token re-sent but Firebase rejected it)
}

export interface DeviceFcmState {
  exists: boolean;
  token: string;           // normalized: "" if missing or legacy marker
  deadAt: number | null;
  deadCount: number;
  lastAttemptAt: number;
  lastSeenAt: number;
  status: string;
  reason: string | null;
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

/** Treat legacy "__UNINSTALLED__" as no token. */
export function normalizeToken(v: unknown): string {
  const t = clean(v);
  return t === UNINSTALLED_MARKER ? "" : t;
}

export function isValidTokenFormat(token: string): boolean {
  const t = clean(token);
  if (!t || t === UNINSTALLED_MARKER) return false;
  if (t.length < MIN_TOKEN_LENGTH) return false;
  if (/\s/.test(t)) return false;
  return true;
}

/** Mongo filter that matches the CURRENT token value exactly (empty matches "", null, missing, legacy marker). */
function tokenFilter(token: string): any {
  return token ? token : { $in: ["", null, UNINSTALLED_MARKER] };
}

/** Mongo filter for a status value read via .lean() (old docs may be missing the field → default "online"). */
function statusFilter(status: string): any {
  return status === "online" ? { $in: ["online", null] } : status;
}

async function emitAdminEvent(event: string, payload: Record<string, any>, opts: Record<string, any>) {
  try {
    const ws = (await import("./wsService")).default;
    ws.broadcastAdminEvent(event, payload, opts);
  } catch (_) {}
}

/* ═══════════════════════════════════════════
   STATUS — single source of truth for transitions
   ═══════════════════════════════════════════ */

/**
 * Apply the correct fcmStatus after PROOF OF LIFE (any app→backend call).
 *
 *   no token        → offline / token_missing
 *   token dead      → offline / token_dead
 *   token healthy   → online
 *
 * Also reverses "uninstalled" (device clearly still has the app) and emits device:recovered.
 * Read + one CAS write. If a concurrent write changed the doc, we no-op — the next call fixes it.
 */
export async function applyAliveStatus(deviceId: string): Promise<{
  changed: boolean;
  recovered: boolean;
  status: string;
  reason: UnreachableReason | null;
}> {
  const noop = { changed: false, recovered: false, status: "", reason: null as UnreachableReason | null };
  try {
    const doc: any = await Device.findOne({ deviceId })
      .select("fcmToken fcmTokenDeadAt fcmStatus unreachableReason")
      .lean();
    if (!doc) return noop;

    const token     = normalizeToken(doc.fcmToken);
    const dead      = doc.fcmTokenDeadAt !== null && doc.fcmTokenDeadAt !== undefined;
    const curStatus = clean(doc.fcmStatus) || "online";
    const curReason = (doc.unreachableReason ?? null) as string | null;

    let target: string;
    let reason: UnreachableReason | null;
    if (!token)    { target = "offline"; reason = "token_missing"; }
    else if (dead) { target = "offline"; reason = "token_dead"; }
    else           { target = "online";  reason = null; }

    if (curStatus === target && curReason === reason) {
      return { changed: false, recovered: false, status: target, reason };
    }

    const now = Date.now();
    const r = await Device.updateOne(
      {
        deviceId,
        fcmToken: tokenFilter(token),
        fcmTokenDeadAt: dead ? { $ne: null } : null,
        fcmStatus: statusFilter(curStatus),
      },
      {
        $set: {
          fcmStatus: target,
          unreachableReason: reason,
          unreachableSince: target === "online" ? null : now,
        },
      },
    );

    if (r.modifiedCount === 0) return { changed: false, recovered: false, status: target, reason };

    const recovered = curStatus === "uninstalled";
    logger.info(`${TAG}: status transition (alive)`, {
      deviceId, from: `${curStatus}/${curReason ?? "-"}`, to: `${target}/${reason ?? "-"}`, recovered,
    });
    if (recovered) {
      await emitAdminEvent("device:recovered", { deviceId, status: target, reason }, { deviceId });
    }
    return { changed: true, recovered, status: target, reason };
  } catch (err: any) {
    logger.warn(`${TAG}: applyAliveStatus failed`, { deviceId, error: err?.message });
    return noop;
  }
}

/** Backwards-compatible alias. Old code called this on every lastSeen. */
export async function markDeviceOnline(deviceId: string): Promise<void> {
  await applyAliveStatus(deviceId);
}

/**
 * Mark a device offline with a reason. Conditional:
 *   - never touches "uninstalled"
 *   - "no_heartbeat" only downgrades from "online" (never overrides token_dead / token_missing)
 *   - no-op if already offline with the same reason
 */
export async function markDeviceOffline(
  deviceId: string,
  reason: UnreachableReason,
): Promise<boolean> {
  try {
    const filter: any = {
      deviceId,
      fcmStatus: { $ne: "uninstalled" },
      $nor: [{ fcmStatus: "offline", unreachableReason: reason }],
    };
    if (reason === "no_heartbeat") filter.fcmStatus = { $in: ["online", null] };

    const r = await Device.updateOne(filter, {
      $set: { fcmStatus: "offline", unreachableReason: reason, unreachableSince: Date.now() },
    });
    if (r.modifiedCount > 0) logger.info(`${TAG}: marked offline`, { deviceId, reason });
    return r.modifiedCount > 0;
  } catch (err: any) {
    logger.warn(`${TAG}: markDeviceOffline failed`, { deviceId, reason, error: err?.message });
    return false;
  }
}

/**
 * Mark device uninstalled — ONLY if the full policy holds, checked atomically in the filter:
 *   - currently offline/token_dead
 *   - token dead for ≥ UNINSTALL_AFTER_DAYS
 *   - Firebase rejected it ≥ UNINSTALL_MIN_DEAD_COUNT times
 *   - no proof-of-life for ≥ UNINSTALL_AFTER_DAYS
 * Does NOT erase the token. Fully reversible by any proof-of-life or successful send.
 */
export async function markDeviceUninstalled(deviceId: string): Promise<boolean> {
  const policy = getUninstallPolicy();
  if (!policy.auto) return false;
  try {
    const now = Date.now();
    const cutoff = now - policy.afterMs;
    const r = await Device.updateOne(
      {
        deviceId,
        fcmStatus: "offline",
        unreachableReason: "token_dead",
        fcmTokenDeadAt: { $ne: null, $lte: cutoff },
        fcmTokenDeadCount: { $gte: policy.minDeadCount },
        "lastSeen.at": { $lte: cutoff },
      },
      {
        $set: {
          fcmStatus: "uninstalled",
          unreachableSince: null,
          unreachableReason: null,
          fcmLastError: "app_uninstalled",
          fcmLastErrorAt: now,
        },
      },
    );
    if (r.modifiedCount > 0) logger.info(`${TAG}: device marked uninstalled`, { deviceId });
    return r.modifiedCount > 0;
  } catch (err: any) {
    logger.warn(`${TAG}: markDeviceUninstalled failed`, { deviceId, error: err?.message });
    return false;
  }
}

/* ═══════════════════════════════════════════
   FCM TOKEN — the ONLY writer of fcmToken
   ═══════════════════════════════════════════ */

/**
 * Store a token the app sent.
 *
 *   DIFFERENT token  → replace (CAS), retire old one, clear dead markers, status online
 *   SAME token       → touch fcmTokenUpdatedAt; if it's marked dead, tell app forceRefresh
 *   RETIRED token    → app re-sent an old token from its cache → ignore, keep the newer one
 *   invalid format   → reject (ok:false); caller should return 400
 *
 * Every branch is proof-of-life → applyAliveStatus().
 */
export async function updateFcmToken(deviceId: string, token: string): Promise<TokenUpdateResult> {
  const t = clean(token);

  if (!isValidTokenFormat(t)) {
    logger.warn(`${TAG}: updateFcmToken rejected invalid token`, { deviceId, length: t.length });
    return { ok: false, replaced: false, tokenStatus: "invalid", forceRefresh: false };
  }

  const now = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur: any = await Device.findOne({ deviceId })
      .select("fcmToken fcmTokenDeadAt fcmRetiredTokens")
      .lean();

    const curToken = normalizeToken(cur?.fcmToken);
    const curDead  = !!cur && cur.fcmTokenDeadAt !== null && cur.fcmTokenDeadAt !== undefined;
    const retired: string[] = Array.isArray(cur?.fcmRetiredTokens) ? cur.fcmRetiredTokens : [];

    /* ── SAME token ── */
    if (curToken === t) {
      await Device.updateOne({ deviceId, fcmToken: t }, { $set: { fcmTokenUpdatedAt: now } });
      await applyAliveStatus(deviceId);
      if (curDead) {
        logger.warn(`${TAG}: app re-sent a token Firebase already rejected → forceRefresh`, { deviceId });
        return { ok: true, replaced: false, tokenStatus: "dead", forceRefresh: true };
      }
      return { ok: true, replaced: false, tokenStatus: "ok", forceRefresh: false };
    }

    /* ── RETIRED (stale) token ── */
    // forceRefresh:true — if the app's SDK cache is stuck on a retired token, the only way out is
    // deleteToken()+getToken(). Cost when it was just cache lag: one extra rotation. Never stuck.
    if (curToken && retired.includes(t)) {
      await applyAliveStatus(deviceId);
      logger.warn(`${TAG}: app sent a retired token — ignored, keeping newer one (forceRefresh)`, { deviceId });
      return { ok: true, replaced: false, tokenStatus: "stale", forceRefresh: true };
    }

    /* ── DIFFERENT token → replace (compare-and-swap on current value) ── */
    const update: any = {
      $set: {
        fcmToken: t,
        fcmTokenUpdatedAt: now,
        fcmTokenDeadAt: null,
        fcmTokenDeadCount: 0,
        fcmLastError: "",
        fcmStatus: "online",
        unreachableSince: null,
        unreachableReason: null,
      },
    };
    if (curToken) {
      update.$push = { fcmRetiredTokens: { $each: [curToken], $slice: -RETIRED_TOKENS_MAX } };
    }

    const r = await Device.updateOne(
      cur ? { deviceId, fcmToken: tokenFilter(curToken) } : { deviceId },
      update,
      { upsert: !cur },
    );

    if (r.matchedCount > 0 || r.upsertedCount > 0) {
      logger.info(`${TAG}: FCM token ${curToken ? "replaced" : "stored"}`, {
        deviceId, tokenLength: t.length, wasDead: curDead, retiredCount: retired.length + (curToken ? 1 : 0),
      });
      return { ok: true, replaced: true, tokenStatus: "ok", forceRefresh: false };
    }
    // CAS lost to a concurrent write — re-read and retry
    logger.debug(`${TAG}: updateFcmToken CAS retry`, { deviceId, attempt });
  }

  // 3 lost races in a row (practically impossible) — still proof of life
  await applyAliveStatus(deviceId);
  logger.warn(`${TAG}: updateFcmToken gave up after CAS retries`, { deviceId });
  return { ok: true, replaced: false, tokenStatus: "ok", forceRefresh: false };
}

/**
 * Mark the CURRENT token dead — only if it's still the token that failed (CAS).
 * If the app swapped the token in between, this is a no-op.
 * Sets status offline/token_dead (never downgrades "uninstalled").
 */
export async function markTokenDead(
  deviceId: string,
  failedToken: string,
  reason: string,
): Promise<{ applied: boolean; deadCount: number; firstDeadAt: number | null }> {
  try {
    const now = Date.now();
    const ft = clean(failedToken);
    if (!ft) return { applied: false, deadCount: 0, firstDeadAt: null };

    // first rejection for this token → stamp deadAt
    await Device.updateOne(
      { deviceId, fcmToken: ft, fcmTokenDeadAt: null },
      { $set: { fcmTokenDeadAt: now } },
    );

    // every rejection → count + error meta
    const r = await Device.updateOne(
      { deviceId, fcmToken: ft },
      { $inc: { fcmTokenDeadCount: 1 }, $set: { fcmLastError: reason, fcmLastErrorAt: now, fcmLastAttemptAt: now } },
    );
    if (r.matchedCount === 0) {
      logger.info(`${TAG}: markTokenDead skipped — token already replaced by app`, { deviceId });
      return { applied: false, deadCount: 0, firstDeadAt: null };
    }

    // status → offline/token_dead (leave "uninstalled" alone; leave as-is if already token_dead)
    await Device.updateOne(
      {
        deviceId,
        fcmToken: ft,
        fcmStatus: { $ne: "uninstalled" },
        $nor: [{ fcmStatus: "offline", unreachableReason: "token_dead" }],
      },
      { $set: { fcmStatus: "offline", unreachableReason: "token_dead", unreachableSince: now } },
    );

    const after: any = await Device.findOne({ deviceId, fcmToken: ft })
      .select("fcmTokenDeadCount fcmTokenDeadAt")
      .lean();
    const deadCount = Number(after?.fcmTokenDeadCount || 0);
    const firstDeadAt = after?.fcmTokenDeadAt ?? null;

    logger.warn(`${TAG}: token marked dead`, {
      deviceId, reason, deadCount, deadForMin: firstDeadAt ? Math.round((now - firstDeadAt) / 60000) : 0,
    });
    return { applied: true, deadCount, firstDeadAt };
  } catch (err: any) {
    logger.warn(`${TAG}: markTokenDead failed`, { deviceId, error: err?.message });
    return { applied: false, deadCount: 0, firstDeadAt: null };
  }
}

/**
 * Firebase ACCEPTED a send for this token → token is registered → app is installed.
 *   - clears dead markers (self-heals a false UNREGISTERED)
 *   - seen ≤ 2h → online; else offline/no_heartbeat
 *   - reverses "uninstalled"
 */
export async function recordSendSuccess(
  deviceId: string,
  token: string,
  messageId: string,
): Promise<void> {
  try {
    const now = Date.now();
    const t = clean(token);

    const before: any = await Device.findOne({ deviceId, fcmToken: t })
      .select("fcmStatus fcmTokenDeadAt")
      .lean();
    if (!before) return; // token replaced meanwhile — nothing to record against
    const wasDead = before.fcmTokenDeadAt !== null && before.fcmTokenDeadAt !== undefined;
    const wasUninstalled = clean(before.fcmStatus) === "uninstalled";

    await Device.updateOne(
      { deviceId, fcmToken: t },
      {
        $set: {
          fcmLastAttemptAt: now,
          fcmLastSuccessAt: now,
          fcmLastMessageId: messageId || "",
          fcmLastError: "",
          fcmTokenDeadAt: null,
          fcmTokenDeadCount: 0,
        },
      },
    );

    // seen recently → online
    const r1 = await Device.updateOne(
      { deviceId, fcmToken: t, fcmStatus: { $ne: "online" }, "lastSeen.at": { $gte: now - ONLINE_WINDOW_MS } },
      { $set: { fcmStatus: "online", unreachableSince: null, unreachableReason: null } },
    );
    // silent → offline/no_heartbeat (fixes token_dead reason and reverses uninstalled)
    const r2 = await Device.updateOne(
      { deviceId, fcmToken: t, $or: [{ fcmStatus: "uninstalled" }, { unreachableReason: "token_dead" }] },
      { $set: { fcmStatus: "offline", unreachableReason: "no_heartbeat", unreachableSince: now } },
    );

    if (wasDead) logger.info(`${TAG}: token RESURRECTED — Firebase accepted a send`, { deviceId });
    if (wasUninstalled && (r1.modifiedCount > 0 || r2.modifiedCount > 0)) {
      logger.info(`${TAG}: uninstalled reversed by successful send`, { deviceId });
      await emitAdminEvent("device:recovered", { deviceId, via: "send_success" }, { deviceId });
    }
  } catch (err: any) {
    logger.warn(`${TAG}: recordSendSuccess failed`, { deviceId, error: err?.message });
  }
}

/** Full FCM state for one device (used by fcmService before sending). */
export async function getDeviceFcmState(deviceId: string): Promise<DeviceFcmState> {
  const empty: DeviceFcmState = {
    exists: false, token: "", deadAt: null, deadCount: 0, lastAttemptAt: 0, lastSeenAt: 0, status: "", reason: null,
  };
  try {
    const d: any = await Device.findOne({ deviceId })
      .select("fcmToken fcmTokenDeadAt fcmTokenDeadCount fcmLastAttemptAt lastSeen.at fcmStatus unreachableReason")
      .lean();
    if (!d) return empty;
    return {
      exists: true,
      token: normalizeToken(d.fcmToken),
      deadAt: d.fcmTokenDeadAt ?? null,
      deadCount: Number(d.fcmTokenDeadCount || 0),
      lastAttemptAt: Number(d.fcmLastAttemptAt || 0),
      lastSeenAt: Number(d.lastSeen?.at || 0),
      status: clean(d.fcmStatus) || "online",
      reason: d.unreachableReason ?? null,
    };
  } catch (err: any) {
    logger.error(`${TAG}: getDeviceFcmState failed`, err);
    return empty;
  }
}

/** Backwards-compatible: just the token ("" if missing / legacy marker). */
export async function getDeviceFcmToken(deviceId: string): Promise<string> {
  const s = await getDeviceFcmState(deviceId);
  return s.token;
}

/** Attempt / error bookkeeping for sends that did NOT change token state. */
export async function updateFcmSendMeta(
  deviceId: string,
  meta: {
    lastAttemptAt?: number;
    lastSuccessAt?: number | null;
    lastErrorAt?: number | null;
    lastError?: string;
    lastMessageId?: string;
  },
) {
  try {
    const setObj: Record<string, any> = {};
    if (typeof meta.lastAttemptAt !== "undefined") setObj.fcmLastAttemptAt = meta.lastAttemptAt;
    if (typeof meta.lastSuccessAt !== "undefined") setObj.fcmLastSuccessAt = meta.lastSuccessAt;
    if (typeof meta.lastErrorAt !== "undefined")   setObj.fcmLastErrorAt   = meta.lastErrorAt;
    if (typeof meta.lastError !== "undefined")     setObj.fcmLastError     = meta.lastError;
    if (typeof meta.lastMessageId !== "undefined") setObj.fcmLastMessageId = meta.lastMessageId;
    if (Object.keys(setObj).length === 0) return null;
    return await Device.findOneAndUpdate({ deviceId }, { $set: setObj }, { new: true });
  } catch (err: any) {
    logger.error(`${TAG}: updateFcmSendMeta failed`, err);
    throw err;
  }
}

/**
 * @deprecated — kept so any remaining import compiles. DOES NOT clear the token anymore.
 * If you see this warning in logs, find the caller and remove it.
 */
export async function clearInvalidFcmToken(deviceId: string, reason?: string): Promise<void> {
  logger.warn(`${TAG}: clearInvalidFcmToken called — this is a no-op now (tokens are never erased)`, { deviceId, reason });
}

/* ═══════════════════════════════════════════
   DEVICE METADATA
   ═══════════════════════════════════════════ */

/**
 * Create or update device metadata (app open / boot / registration).
 * Token (if present) is routed through updateFcmToken() — never written directly.
 */
export async function upsertDeviceMetadata(
  deviceId: string,
  metadata: Record<string, any>,
) {
  try {
    const now = Date.now();
    const { fcmToken: rawToken, ...metaWithoutToken } = metadata || {};
    const fcmToken = typeof rawToken === "string" ? rawToken.trim() : "";

    await Device.findOneAndUpdate(
      { deviceId },
      { $set: { metadata: metaWithoutToken, "lastSeen.at": now, "lastSeen.action": "register" } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (fcmToken) await updateFcmToken(deviceId, fcmToken);
    await applyAliveStatus(deviceId);

    return await Device.findOne({ deviceId });
  } catch (err: any) {
    logger.error(`${TAG}: upsertDeviceMetadata failed`, err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   LAST SEEN  (every call = proof of life)
   ═══════════════════════════════════════════ */

export async function updateLastSeen(
  deviceId: string,
  action: string,
  battery: number = -1,
) {
  try {
    const now = Date.now();
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          "lastSeen.at": now,
          "lastSeen.action": action || "unknown",
          "lastSeen.battery": typeof battery === "number" && battery >= 0 ? battery : -1,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await applyAliveStatus(deviceId);
    return doc;
  } catch (err: any) {
    logger.error(`${TAG}: updateLastSeen failed`, err);
    throw err;
  }
}

export async function touchLastSeen(deviceId: string, action?: string) {
  try {
    const setObj: Record<string, any> = { "lastSeen.at": Date.now() };
    if (action) setObj["lastSeen.action"] = action;
    await Device.findOneAndUpdate({ deviceId }, { $set: setObj }, { upsert: true });
    await applyAliveStatus(deviceId);
  } catch (err: any) {
    logger.warn(`${TAG}: touchLastSeen failed`, { deviceId, error: err?.message });
  }
}

/* ═══════════════════════════════════════════
   SIM SLOT / SIM INFO / ADMINS / FORWARDING — unchanged
   ═══════════════════════════════════════════ */

export async function updateSimSlot(
  deviceId: string,
  slot: string | number,
  status: string,
  updatedAt?: number,
) {
  try {
    const payload: Record<string, any> = {};
    payload[`simSlots.${slot}.status`] = status || "inactive";
    payload[`simSlots.${slot}.updatedAt`] = Number(updatedAt || Date.now());
    return await Device.findOneAndUpdate(
      { deviceId },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err: any) {
    logger.error(`${TAG}: updateSimSlot failed`, err);
    throw err;
  }
}

export async function upsertSimInfo(deviceId: string, simInfo: Record<string, any>) {
  try {
    return await Device.findOneAndUpdate(
      { deviceId },
      { $set: { simInfo } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err: any) {
    logger.error(`${TAG}: upsertSimInfo failed`, err);
    throw err;
  }
}

export async function getDeviceAdmins(deviceId: string): Promise<string[]> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return (doc && (doc as any).admins) || [];
  } catch (err: any) {
    logger.error(`${TAG}: getDeviceAdmins failed`, err);
    return [];
  }
}

export async function getDeviceAdminPhone(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return ((doc as any)?.adminPhone || "").toString();
  } catch (err: any) {
    logger.error(`${TAG}: getDeviceAdminPhone failed`, err);
    return "";
  }
}

export async function setForwardingSim(deviceId: string, value: string) {
  try {
    return await Device.findOneAndUpdate(
      { deviceId },
      { $set: { forwardingSim: value } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err: any) {
    logger.error(`${TAG}: setForwardingSim failed`, err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   LOOKUP / DELETE — unchanged
   ═══════════════════════════════════════════ */

export async function getDevice(deviceId: string) {
  try {
    return await Device.findOne({ deviceId }).lean();
  } catch (err: any) {
    logger.error(`${TAG}: getDevice failed`, err);
    return null;
  }
}

export async function getAllDevices() {
  try {
    return await Device.find().sort({ "lastSeen.at": -1 }).lean();
  } catch (err: any) {
    logger.error(`${TAG}: getAllDevices failed`, err);
    return [];
  }
}

export async function deleteDevice(deviceId: string) {
  try {
    return await Device.findOneAndDelete({ deviceId }).lean();
  } catch (err: any) {
    logger.error(`${TAG}: deleteDevice failed`, err);
    throw err;
  }
}
