import { Response } from "express";

/**
 * Small helpers to standardize API JSON responses.
 * All responses follow { success: boolean, error?: string, data?: any }
 */

export function sendSuccess(res: Response, data: any = null, status = 200) {
  if (data === null) {
    return res.status(status).json({ success: true });
  }
  return res.status(status).json({ success: true, data });
}

export function sendError(res: Response, message: string = "Server error", status = 500) {
  return res.status(status).json({ success: false, error: message });
}
