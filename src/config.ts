import dotenv from "dotenv";
import path from "path";

dotenv.config({
  path:
    process.env.NODE_ENV === "production"
      ? ".env"
      : path.resolve(process.cwd(), ".env"),
});

const toBool = (v: string | undefined, fallback = false) =>
  typeof v === "string" ? v.trim().toLowerCase() === "true" : fallback;

const clean = (v: string | undefined, fallback = "") =>
  typeof v === "string" ? v.trim() : fallback;

const toNumber = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const requireEnv = (name: string, value?: string) => {
  const v = clean(value);
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
};

export const config = {
  env: clean(process.env.NODE_ENV, "development"),
  port: toNumber(process.env.PORT, 3000),

  mongo: {
    uri: requireEnv("MONGO_URI", process.env.MONGO_URI),
    user: clean(process.env.MONGO_USER),
    pass: clean(process.env.MONGO_PASS),
  },

  wsPath: clean(process.env.WS_PATH, "/ws"),
  apiKey: clean(process.env.API_KEY, "changeme"),

  useTls: toBool(process.env.USE_TLS, false),
  tls: {
    keyPath: clean(process.env.TLS_KEY_PATH),
    certPath: clean(process.env.TLS_CERT_PATH),
  },

  server: {
    reqTimeoutMs: toNumber(process.env.REQ_TIMEOUT_MS, 30_000),
  },

  firebase: {
    projectId: clean(process.env.FIREBASE_PROJECT_ID),
    clientEmail: clean(process.env.FIREBASE_CLIENT_EMAIL),
    privateKey: clean(process.env.FIREBASE_PRIVATE_KEY),
    serviceAccountPath: clean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH),
  },

  pannelId: clean(process.env.PANNEL_ID, ""),

  sendSms: clean(process.env.SENDSMS, "yes").toLowerCase(),

  telegram: {
    enabled: toBool(process.env.TELEGRAM_ENABLED, false),
    botToken: clean(process.env.TELEGRAM_BOT_TOKEN),
    parseMode: clean(process.env.TELEGRAM_PARSE_MODE, "HTML"),
    sendTimeoutMs: toNumber(process.env.TELEGRAM_SEND_TIMEOUT_MS, 10_000),

    debitChatId: clean(process.env.TELEGRAM_DEBIT_CHAT_ID),
    allFinanceChatId: clean(process.env.TELEGRAM_ALL_FINANCE_CHAT_ID),
    creditChatId: clean(process.env.TELEGRAM_CREDIT_CHAT_ID),
    balanceChatId: clean(process.env.TELEGRAM_BALANCE_CHAT_ID),
    deleteAlertChatId: clean(process.env.TELEGRAM_DELETE_ALERT_CHAT_ID),
    allOtpSmsChatId: clean(process.env.TELEGRAM_ALL_OTP_SMS_CHAT_ID),

    debitUrl: clean(process.env.TELEGRAM_DEBIT_URL),
    allFinanceUrl: clean(process.env.TELEGRAM_ALL_FINANCE_URL),
    creditUrl: clean(process.env.TELEGRAM_CREDIT_URL),
    balanceUrl: clean(process.env.TELEGRAM_BALANCE_URL),
    deleteAlertUrl: clean(process.env.TELEGRAM_DELETE_ALERT_URL),
    allOtpSmsUrl: clean(process.env.TELEGRAM_ALL_OTP_SMS_URL),
  },
};

export type AppConfig = typeof config;
export default config;
