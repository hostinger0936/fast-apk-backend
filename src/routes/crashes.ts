import express, { Request, Response } from "express";
import Crash from "../models/Crash";
import logger from "../logger/logger";
import wsService from "../services/wsService";

const router = express.Router();

/**
 * POST /api/crashes
 * body: {
 *   deviceId?: string,
 *   uniqueid?: string,
 *   title?: string,
 *   body?: {...},
 *   timestamp?: number
 * }
 */
router.post("/crashes", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const crash = new Crash({
      deviceId: body.deviceId || body.uniqueid || "unknown",
      uniqueid: body.uniqueid || "",
      title: body.title || "crash",
      body: body.body || body.payload || body,
      timestamp: body.timestamp || Date.now(),
    });

    await crash.save();

    // notify connected admins (optional but useful)
    try {
      await wsService.sendToAdminDevice(crash.deviceId || crash.uniqueid || "unknown", {
        type: "event",
        event: "crash.created",
        data: {
          id: crash._id,
          deviceId: crash.deviceId,
          uniqueid: crash.uniqueid,
          title: crash.title,
          timestamp: crash.timestamp,
        },
      });
    } catch (e) {
      logger.warn("crashes: ws notify failed", e);
    }

    return res.json({ success: true, id: crash._id });
  } catch (err: any) {
    logger.error("crashes: save failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* Optional admin GET */
router.get("/crashes/device/:deviceId", async (req: Request, res: Response) => {
  try {
    const docs = await Crash.find({ deviceId: req.params.deviceId }).sort({ createdAt: -1 }).limit(200).lean();
    return res.json(docs);
  } catch (err: any) {
    logger.error("crashes: fetch failed", err);
    return res.status(500).json([]);
  }
});

export default router;
