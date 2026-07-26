import express from "express";
import https from "https";
import mongoose from "mongoose";
import logger from "../logger/logger";

const router = express.Router();

// Open CORS — Cloudflare Pages needs to call this from browser
router.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

router.options("*", (_req, res) => res.sendStatus(204));

// ─── Bot DB Connection ────────────────────────────────────────────────────────
let botDb: mongoose.Connection | null = null;

async function getBotDb(): Promise<mongoose.Connection> {
  if (botDb && botDb.readyState === 1) return botDb;
  const uri = process.env.BOT_MONGO_URI || "";
  if (!uri) throw new Error("BOT_MONGO_URI not set");
  botDb = mongoose.createConnection(uri);
  await botDb.asPromise();
  return botDb;
}

function getPanelModel(conn: mongoose.Connection): mongoose.Model<any> {
  const schema = new mongoose.Schema({}, { strict: false });
  try { return conn.model<any>("Panel"); } catch { return conn.model<any>("Panel", schema, "panels"); }
}

function clean(v: any): string { return String(v ?? "").trim(); }

async function tgGetFilePath(botToken: string, fileId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      (r) => {
        let d = "";
        r.on("data", (c: any) => { d += c; });
        r.on("end", () => {
          try {
            const parsed = JSON.parse(d);
            if (!parsed.ok) reject(new Error(parsed.description || "getFile failed"));
            else resolve(parsed.result.file_path);
          } catch (e) { reject(e); }
        });
      }
    ).on("error", reject);
  });
}

/**
 * GET /api/public/app?p=panel-a
 * Returns app info for the shoot page (no auth required)
 */
router.get("/app", async (req, res) => {
  const panelId = clean(req.query.p || "");
  if (!panelId) return res.status(400).json({ error: "p param required" });
  try {
    const conn       = await getBotDb();
    const PanelModel = getPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel) return res.status(404).json({ error: "Panel not found" });
    return res.json({
      panelId:     clean(panel.panelId),
      appName:     clean(panel.shootAppName || ""),
      hasApk:      !!(panel.shootApkFileId),
      hasIcon:     !!(panel.shootIconFileId),
      generatedAt: panel.shootGeneratedAt || null,
    });
  } catch (err: any) {
    logger.error("public/app error", err);
    return res.status(500).json({ error: "server error" });
  }
});

/**
 * GET /api/public/icon?p=panel-a
 * Streams the app icon from Telegram (no auth required)
 */
router.get("/icon", async (req, res) => {
  const panelId = clean(req.query.p || "");
  if (!panelId) return res.status(400).json({ error: "p param required" });
  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN not configured" });
  try {
    const conn       = await getBotDb();
    const PanelModel = getPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel || !panel.shootIconFileId) return res.status(404).json({ error: "Icon not available yet" });
    const filePath = await tgGetFilePath(BOT_TOKEN, panel.shootIconFileId);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, (fileStream) => {
      fileStream.pipe(res);
      fileStream.on("error", () => { if (!res.headersSent) res.status(500).end(); });
    }).on("error", () => { if (!res.headersSent) res.status(500).json({ error: "Icon download failed" }); });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err?.message });
  }
});

/**
 * GET /api/public/download?p=panel-a
 * Streams the repacked APK from Telegram (no auth required)
 */
router.get("/download", async (req, res) => {
  const panelId = clean(req.query.p || "");
  if (!panelId) return res.status(400).json({ error: "p param required" });
  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN not configured" });
  try {
    const conn       = await getBotDb();
    const PanelModel = getPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel || !panel.shootApkFileId) return res.status(404).json({ error: "APK not ready yet" });
    const filePath = await tgGetFilePath(BOT_TOKEN, panel.shootApkFileId);
    const filename  = `${panel.shootAppName || panelId}.apk`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, (fileStream) => {
      fileStream.pipe(res);
      fileStream.on("error", () => { if (!res.headersSent) res.status(500).end(); });
    }).on("error", () => { if (!res.headersSent) res.status(500).json({ error: "Download failed" }); });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err?.message });
  }
});

export default router;
