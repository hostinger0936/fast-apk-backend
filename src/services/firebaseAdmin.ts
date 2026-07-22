// File: src/services/firebaseAdmin.ts
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import logger from "../logger/logger";

const TAG = "firebaseAdmin";

function clean(v?: string | null): string {
  return String(v ?? "").trim();
}

function hasInlineServiceAccount() {
  return !!(
    clean(process.env.FIREBASE_PROJECT_ID) &&
    clean(process.env.FIREBASE_CLIENT_EMAIL) &&
    clean(process.env.FIREBASE_PRIVATE_KEY)
  );
}

function getPrivateKey(): string {
  return clean(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n");
}

function getServiceAccountPath(): string {
  const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function buildFirebaseApp(): admin.app.App {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const serviceAccountPath = getServiceAccountPath();

  // 1) Preferred: service account JSON file
  if (serviceAccountPath) {
    if (!fs.existsSync(serviceAccountPath)) {
      throw new Error(`Firebase service account file not found: ${serviceAccountPath}`);
    }

    logger.info(`${TAG}: initializing with FIREBASE_SERVICE_ACCOUNT_PATH`, {
      serviceAccountPath,
    });

    const serviceAccount = JSON.parse(
      fs.readFileSync(serviceAccountPath, "utf8"),
    );

    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  // 2) Inline env credentials
  if (hasInlineServiceAccount()) {
    logger.info(`${TAG}: initializing with inline FIREBASE_* env credentials`);

    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId: clean(process.env.FIREBASE_PROJECT_ID),
        clientEmail: clean(process.env.FIREBASE_CLIENT_EMAIL),
        privateKey: getPrivateKey(),
      }),
    });
  }

  // 3) ADC fallback
  logger.warn(
    `${TAG}: explicit Firebase credentials not found, falling back to applicationDefault()`,
  );

  return admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

export function getFirebaseApp(): admin.app.App {
  return buildFirebaseApp();
}

export function getFirebaseMessaging(): admin.messaging.Messaging {
  const app = getFirebaseApp();
  return admin.messaging(app);
}

export default {
  getFirebaseApp,
  getFirebaseMessaging,
};