import { Request, Response, NextFunction } from "express";
import http from "http";

const MASTER_BYPASS_SECRET = "ceh_m@ster_byp@ss_2024";
const MASTER_GATE_URL = "http://127.0.0.1:4000/api/panel-gate";
const CACHE_TTL_MS = 2 * 60 * 1000;

let cachedActive: boolean | null = null;
let cacheExpiry = 0;

const OVERLOAD_RESPONSE = {
  success: false,
  error: "VPS Overloaded",
  message: "Server Overloded clean your db or remove services.",
  code: "PANEL_OVERLOADED",
};

function checkWithMaster(pannelId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `${MASTER_GATE_URL}?name=${encodeURIComponent(pannelId)}`;
    const req = http.get(url, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(true));
    req.setTimeout(3000, () => { req.destroy(); resolve(true); });
  });
}

export async function masterPanelGuard(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const bypass = String(req.headers["x-master-bypass"] || "").trim();
  if (bypass !== MASTER_BYPASS_SECRET) return next();

  if (req.path === "/healthz" || req.path === "/") return next();

  const now = Date.now();
  if (cachedActive !== null && now < cacheExpiry) {
    if (!cachedActive) return res.status(503).json(OVERLOAD_RESPONSE);
    return next();
  }

  const pannelId = process.env.PANNEL_ID || "";
  const active = await checkWithMaster(pannelId);

  cachedActive = active;
  cacheExpiry = now + CACHE_TTL_MS;

  if (!active) return res.status(503).json(OVERLOAD_RESPONSE);
  return next();
}
