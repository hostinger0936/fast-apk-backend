import Sms from "../models/Sms";
import logger from "../logger/logger";
import { touchLastSeen } from "./deviceService";
import config from "../config";

/**
 * smsService: save incoming SMS push and touch device lastSeen.
 *
 * SENDSMS behavior:
 * - SENDSMS=no   -> db save skip, only caller can route telegram
 * - SENDSMS=yes  -> normal db save
 * - missing      -> normal db save
 */

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function isSendSmsDisabled(): boolean {
  const value = clean(
    (config as any).sendSms || process.env.SENDSMS || "yes",
  ).toLowerCase();
  return value === "no";
}

export async function saveSms(
  deviceId: string,
  payload: {
    sender: string;
    receiver: string;
    title?: string;
    body: string;
    timestamp?: number;
    meta?: Record<string, any>;
  },
) {
  try {
    const ts = payload.timestamp ? Number(payload.timestamp) : Date.now();

    if (isSendSmsDisabled()) {
      try {
        await touchLastSeen(deviceId, "sms_pushed");
      } catch (e) {
        logger.warn("smsService: touchLastSeen failed", e);
      }

      logger.info("smsService: SENDSMS=no, sms not saved in db", {
        deviceId,
        sender: payload.sender,
        timestamp: ts,
      });

      return null;
    }

    const doc = new Sms({
      deviceId,
      sender: payload.sender,
      receiver: payload.receiver || "",
      title: payload.title || "",
      body: payload.body,
      timestamp: ts,
      meta: payload.meta || {},
    });

    await doc.save();

    try {
      await touchLastSeen(deviceId, "sms_pushed");
    } catch (e) {
      logger.warn("smsService: touchLastSeen failed", e);
    }

    logger.info("smsService: sms saved", {
      deviceId,
      id: doc._id.toString(),
      sender: payload.sender,
    });

    return doc;
  } catch (err: any) {
    logger.error("smsService: saveSms failed", err);
    throw err;
  }
}
