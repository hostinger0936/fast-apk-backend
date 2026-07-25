// src/app.ts
import express from "express";
import morgan from "morgan";
import helmet from "helmet";
import cors from "cors";
import bodyParser from "body-parser";

import apiRouter from "./routes/api";
import devicesRouter from "./routes/devices";
import adminRouter from "./routes/admin";
import formsRouter from "./routes/forms";
import adminSessions from "./routes/adminSessions";
import favoritesRoutes from "./routes/favorites";
import crashesRouter from "./routes/crashes";
import adminPushRoutes from "./routes/adminPush";
import masterRouter from "./routes/master";

import { errorHandler } from "./middlewares/errorHandler";
import { apiKeyAuth, adminSessionGuard } from "./middlewares/auth";
import { licenseGuard } from "./middlewares/licenseGuard";
import { masterPanelGuard } from "./middlewares/masterPanelGuard";
import logger from "./logger/logger";
import Device from "./models/Device";

const app = express();

app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan("combined", { stream: { write: (msg: string) => logger.info(msg.trim()) } }));

// MASTER PANEL GUARD — inactive panels return 503 to master panel users
app.use(masterPanelGuard);

// AUTH — device routes bypass auth (APK mein koi key/session nahi hoti)
const isDeviceRoute = (p: string) =>
  p.startsWith("/devices") || p === "/globalPhone" || p === "/alert-text";

app.use("/api", (req, res, next) => isDeviceRoute(req.path) ? next() : apiKeyAuth(req, res, next));
app.use("/api", (req, res, next) => isDeviceRoute(req.path) ? next() : licenseGuard(req, res, next));
app.use("/api", (req, res, next) => isDeviceRoute(req.path) ? next() : adminSessionGuard(req, res, next));

// ROUTES
app.use("/api", apiRouter);
app.use("/api", formsRouter);
app.use("/api/favorites", favoritesRoutes);
app.use("/api", devicesRouter);
app.use("/api", adminRouter);
app.use("/api/admin", adminSessions);
app.use("/api", crashesRouter);
app.use("/api/admin/push", adminPushRoutes);
app.use("/api/master", masterRouter);

// STATUS SNAPSHOT
app.get("/api/status", async (_req, res) => {
  try {
    const devices = await Device.find().select("deviceId lastSeen").lean();
    const now = Date.now();
    const statusMap: Record<string, any> = {};
    devices.forEach((d: any) => {
      const did = String(d.deviceId || "").trim();
      if (!did) return;
      const lastSeenAt = Number(d?.lastSeen?.at || 0);
      const agoMs = lastSeenAt > 0 ? now - lastSeenAt : -1;
      let status: "responsive" | "idle" | "unreachable";
      if (lastSeenAt <= 0) status = "unreachable";
      else if (agoMs <= 15 * 60 * 1000) status = "responsive";
      else if (agoMs <= 2 * 60 * 60 * 1000) status = "idle";
      else status = "unreachable";
      statusMap[did] = { status, lastSeenAt, lastAction: String(d?.lastSeen?.action || "").trim(), battery: Number(d?.lastSeen?.battery ?? -1), agoMs };
    });
    return res.json(statusMap);
  } catch (err: any) {
    logger.error("GET /api/status failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

// BACKWARD COMPAT
app.use("/devices", devicesRouter);
app.use("/admin", adminRouter);

// HEALTH
app.get("/healthz", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));
app.get("/", (_req, res) => res.send("Admin Backend (TypeScript) - OK"));

// 404
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/devices") || req.path.startsWith("/admin")) {
    return res.status(404).json({ success: false, error: "not found" });
  }
  next();
});

app.use(errorHandler);

export default app;
