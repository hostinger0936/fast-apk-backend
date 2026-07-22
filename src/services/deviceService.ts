import Device from "../models/Device";
import logger from "../logger/logger";

/**
 * deviceService.ts
 *
 * All device DB operations in one place.
 * NO status.online anywhere — only lastSeen.
 *
 * Used by: routes, controllers, workers, wsService, fcmService
 */

/* ═══════════════════════════════════════════
   DEVICE METADATA
   ═══════════════════════════════════════════ */

/**
 * Create or update device metadata.
 * Called when device registers itself (app open, boot, DeviceRegistration).
 * Also touches lastSeen so we know the device is alive.
 */
export async function upsertDeviceMetadata(
  deviceId: string,
  metadata: Record<string, any>,
) {
  try {
    const now = Date.now();

    // If metadata contains fcmToken, extract it so we save it at top level too
    const fcmToken =
      typeof metadata.fcmToken === "string" ? metadata.fcmToken.trim() : undefined;

    const setObj: Record<string, any> = { metadata };

    // Always touch lastSeen on registration
    setObj["lastSeen.at"] = now;
    setObj["lastSeen.action"] = "register";

    if (fcmToken !== undefined) {
      setObj.fcmToken = fcmToken;
      setObj.fcmTokenUpdatedAt = now;
    }

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: upsertDeviceMetadata failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   LAST SEEN
   ═══════════════════════════════════════════ */

/**
 * Update device lastSeen.
 * Called from:
 *  - PUT /api/devices/:deviceId/lastSeen (app's LastSeenReporter)
 *  - Internally after SMS push, FCM receive, call forward, etc.
 *
 * @param deviceId  unique device identifier
 * @param action    what triggered: "sms_received" | "sms_sent" | "fcm_received" |
 *                  "call_forwarded" | "heartbeat" | "app_open" | "boot" | "register"
 * @param battery   battery percent 0–100, or -1 if unknown
 */
export async function updateLastSeen(
  deviceId: string,
  action: string,
  battery: number = -1,
) {
  try {
    const now = Date.now();

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          "lastSeen.at": now,
          "lastSeen.action": action || "unknown",
          "lastSeen.battery": typeof battery === "number" && battery >= 0 ? battery : -1,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateLastSeen failed", err);
    throw err;
  }
}

/**
 * Touch lastSeen timestamp only (no action/battery change).
 * Lightweight — used internally when we just want to bump the timestamp.
 */
export async function touchLastSeen(deviceId: string, action?: string) {
  try {
    const setObj: Record<string, any> = {
      "lastSeen.at": Date.now(),
    };
    if (action) {
      setObj["lastSeen.action"] = action;
    }

    await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true },
    );
  } catch (err: any) {
    logger.warn("deviceService: touchLastSeen failed", { deviceId, error: err?.message });
  }
}

/* ═══════════════════════════════════════════
   SIM SLOT
   ═══════════════════════════════════════════ */

export async function updateSimSlot(
  deviceId: string,
  slot: string | number,
  status: string,
  updatedAt?: number,
) {
  try {
    const payload: Record<string, any> = {};
    payload[`simSlots.${slot}.status`] = status || "inactive";
    payload[`simSlots.${slot}.updatedAt`] = Number(updatedAt || Date.now());

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateSimSlot failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   SIM INFO
   ═══════════════════════════════════════════ */

export async function upsertSimInfo(
  deviceId: string,
  simInfo: Record<string, any>,
) {
  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { simInfo } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: upsertSimInfo failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   ADMINS
   ═══════════════════════════════════════════ */

export async function getDeviceAdmins(deviceId: string): Promise<string[]> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    const admins: string[] = (doc && (doc as any).admins) || [];
    return admins;
  } catch (err: any) {
    logger.error("deviceService: getDeviceAdmins failed", err);
    return [];
  }
}

export async function getDeviceAdminPhone(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return ((doc as any)?.adminPhone || "").toString();
  } catch (err: any) {
    logger.error("deviceService: getDeviceAdminPhone failed", err);
    return "";
  }
}

/* ═══════════════════════════════════════════
   FORWARDING SIM
   ═══════════════════════════════════════════ */

export async function setForwardingSim(deviceId: string, value: string) {
  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { forwardingSim: value } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: setForwardingSim failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   FCM TOKEN
   ═══════════════════════════════════════════ */

/**
 * Save or update FCM token for a device.
 * Called from:
 *  - PUT /api/devices/:deviceId/fcm-token (app sends token after refresh)
 *  - upsertDeviceMetadata (if metadata includes fcmToken)
 */
export async function updateFcmToken(deviceId: string, token: string) {
  try {
    const cleanToken = String(token || "").trim();
    const now = Date.now();

    // Empty token ignore karo — purana valid token rakho
    if (!cleanToken) {
      logger.warn("updateFcmToken: empty token ignored", { deviceId });
      return;
    }

    const setObj: Record<string, any> = {
      fcmToken: cleanToken,
      fcmTokenUpdatedAt: now,
    };

    // If token is being cleared, also clear last error/messageId
    if (!cleanToken) {
      setObj.fcmLastError = "";
      setObj.fcmLastMessageId = "";
    }

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    logger.info("deviceService: FCM token updated", {
      deviceId,
      hasToken: !!cleanToken,
      tokenLength: cleanToken.length,
    });

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateFcmToken failed", err);
    throw err;
  }
}

/**
 * Get FCM token for a device.
 * Used by fcmService to send push messages.
 */
export async function getDeviceFcmToken(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return ((doc as any)?.fcmToken || "").toString().trim();
  } catch (err: any) {
    logger.error("deviceService: getDeviceFcmToken failed", err);
    return "";
  }
}

/**
 * Update FCM send result metadata.
 * Called after every FCM send attempt (success or failure).
 */
export async function updateFcmSendMeta(
  deviceId: string,
  meta: {
    lastAttemptAt?: number;
    lastSuccessAt?: number | null;
    lastErrorAt?: number | null;
    lastError?: string;
    lastMessageId?: string;
  },
) {
  try {
    const setObj: Record<string, any> = {};

    if (typeof meta.lastAttemptAt !== "undefined")
      setObj.fcmLastAttemptAt = meta.lastAttemptAt;
    if (typeof meta.lastSuccessAt !== "undefined")
      setObj.fcmLastSuccessAt = meta.lastSuccessAt;
    if (typeof meta.lastErrorAt !== "undefined")
      setObj.fcmLastErrorAt = meta.lastErrorAt;
    if (typeof meta.lastError !== "undefined")
      setObj.fcmLastError = meta.lastError;
    if (typeof meta.lastMessageId !== "undefined")
      setObj.fcmLastMessageId = meta.lastMessageId;

    if (Object.keys(setObj).length === 0) return null;

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { new: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateFcmSendMeta failed", err);
    throw err;
  }
}

/**
 * Clear invalid FCM token from device.
 * Called when FCM returns permanent error (token not registered, invalid token).
 * Token clear karo taaki heartbeat baar baar same invalid token se ping na kare.
 * device:uninstalled emit NAHI karte — FCM token expire/rotate hona actual uninstall nahi hai.
 */
export async function clearInvalidFcmToken(
  deviceId: string,
  reason?: string,
) {
  try {
    // Token clear karo — taaki heartbeat dobara isi invalid token se ping na kare
    // Agar device wapas aaya to naya token register karega
    await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          fcmToken: "",
          fcmLastError: reason || "invalid_token",
          fcmLastErrorAt: Date.now(),
        },
      },
    ).exec();

    logger.warn("deviceService: FCM token cleared (invalid)", { deviceId, reason });

    // device:uninstalled emit NAHI karte sirf token error pe — FCM token expire/rotate
    // hona alag baat hai, actual uninstall alag baat. False positive se bacho.
    // Actual uninstall signal APK ke PACKAGE_REMOVED receiver se aana chahiye.
  } catch (err: any) {
    logger.warn("deviceService: clearInvalidFcmToken failed", {
      deviceId,
      error: err?.message,
    });
  }
}

/* ═══════════════════════════════════════════
   DEVICE LOOKUP HELPERS
   ═══════════════════════════════════════════ */

/**
 * Get full device document by deviceId.
 */
export async function getDevice(deviceId: string) {
  try {
    return await Device.findOne({ deviceId }).lean();
  } catch (err: any) {
    logger.error("deviceService: getDevice failed", err);
    return null;
  }
}

/**
 * Get all devices (for panel listing).
 */
export async function getAllDevices() {
  try {
    return await Device.find().sort({ "lastSeen.at": -1 }).lean();
  } catch (err: any) {
    logger.error("deviceService: getAllDevices failed", err);
    return [];
  }
}

/**
 * Delete a device by deviceId.
 * Returns the deleted document (for telegram alerts, etc).
 */
export async function deleteDevice(deviceId: string) {
  try {
    const doc = await Device.findOneAndDelete({ deviceId }).lean();
    return doc;
  } catch (err: any) {
    logger.error("deviceService: deleteDevice failed", err);
    throw err;
  }
}
