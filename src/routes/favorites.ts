import express, { Request, Response } from "express";
import Device from "../models/Device";
import logger from "../logger/logger";
import wsService from "../services/wsService";

const router = express.Router();

/**
 * GET /favorites
 * Returns all favorites map
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const devices = await Device.find({}, "deviceId favorite").lean();

    const map: Record<string, boolean> = {};

    devices.forEach((d: any) => {
      map[d.deviceId] = d.favorite === true;
    });

    res.json(map);
  } catch (err) {
    logger.error("favorites list failed", err);
    res.status(500).json({ error: "server error" });
  }
});

/**
 * PUT /favorites/:deviceId
 */
router.put("/:deviceId", async (req: Request, res: Response) => {
  const { deviceId } = req.params;
  const { favorite } = req.body;

  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { favorite: favorite === true } },
      { upsert: true, new: true }
    ).lean();

    try {
      wsService.broadcastFavoriteUpdate(deviceId, favorite === true);
    } catch (e) {
      logger.warn("favorites: broadcast favorite:update failed", e);
    }

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("favorites: broadcast device:upsert failed", e);
    }

    res.json({ success: true });
  } catch (err) {
    logger.error("favorite update failed", err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
