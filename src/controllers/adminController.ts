import { Request, Response } from "express";
import AdminModel from "../models/Admin";
import wsService from "../services/wsService";
import logger from "../logger/logger";

export async function getGlobalPhone(req: Request, res: Response) {
  try {
    const doc = await AdminModel.findOne({ key: "global" }).lean();
    return res.json({ phone: (doc && doc.phone) || "" });
  } catch (err: any) {
    logger.error("controller: getGlobalPhone failed", err);
    return res.status(500).json({ phone: "" });
  }
}

export async function setGlobalPhone(req: Request, res: Response) {
  const phone = (req.body && req.body.phone) || "";
  if (!phone)
    return res
      .status(400)
      .json({ success: false, error: "missing phone" });

  try {
    await AdminModel.findOneAndUpdate(
      { key: "global" },
      { $set: { phone } },
      { upsert: true, new: true },
    );

    // broadcast to connected admin panels
    try {
      wsService.broadcastGlobalAdminUpdate(phone);
    } catch {
      // ignore
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: setGlobalPhone failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}