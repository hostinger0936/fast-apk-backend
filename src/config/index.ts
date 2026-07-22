import dotenv from "dotenv";
import path from "path";

dotenv.config({
  path: process.env.NODE_ENV === "production"
    ? ".env"
    : path.resolve(process.cwd(), ".env"),
});

const toBool = (v: string | undefined, fallback = false) =>
  typeof v === "string" ? v.toLowerCase() === "true" : fallback;

export const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  mongo: {
    uri: process.env.MONGO_URI || "mongodb://localhost:27017/admin_db",
    user: process.env.MONGO_USER || "",
    pass: process.env.MONGO_PASS || "",
  },
  wsPath: process.env.WS_PATH || "/ws",
  apiKey: process.env.API_KEY || "changeme",
  useTls: toBool(process.env.USE_TLS, false),
  tls: {
    keyPath: process.env.TLS_KEY_PATH || "",
    certPath: process.env.TLS_CERT_PATH || "",
  },
  // Useful timeouts / limits
  server: {
    reqTimeoutMs: Number(process.env.REQ_TIMEOUT_MS || 30_000),
  },
};

export type AppConfig = typeof config;
export default config;
