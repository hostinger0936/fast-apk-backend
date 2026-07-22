import { Request, Response, NextFunction } from "express";
import logger from "../logger/logger";

/**
 * Global error handler for express.
 * Always responds with JSON: { success: false, error: "<message>" }
 */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  try {
    const status = err && err.status && typeof err.status === "number" ? err.status : 500;
    const message =
      (err && (err.message || (typeof err === "string" ? err : null))) ||
      "Internal server error";

    logger.error("errorHandler:", { path: req.path, message, stack: err && err.stack ? err.stack : null });

    // don't leak stack in production responses
    const resp: any = { success: false, error: message };
    return res.status(status).json(resp);
  } catch (e) {
    logger.error("errorHandler failed:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
