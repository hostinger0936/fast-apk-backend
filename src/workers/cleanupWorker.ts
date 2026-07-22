/**
 * cleanupWorker.ts
 *
 * Periodic housekeeping:
 * - Remove very old SMS / Payments (configurable)
 * - Mark stale pending payments as 'failed' after X hours
 * - Auto-delete contacts older than 24 hours
 */
import logger from "../logger/logger";
import Payment from "../models/Payment";
import Sms from "../models/Sms";

const INTERVAL_MS = 1000 * 60 * 30; // 30 minutes
const STALE_PAYMENT_HOURS = 24; // mark pending payments older than this as failed
const DELETE_SMS_OLDER_DAYS = 10;
const DELETE_CONTACTS_OLDER_HOURS = 24; // auto-delete contacts after 24 hours

let timer: NodeJS.Timeout | null = null;

export function start() {
  if (timer) {
    logger.warn("cleanupWorker: already running");
    return;
  }
  logger.info("cleanupWorker: starting");
  timer = setInterval(() => run().catch((e) => logger.error("cleanupWorker error", e)), INTERVAL_MS);
  // run immediate
  run().catch((e) => logger.error("cleanupWorker initial run failed", e));
}

export async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  logger.info("cleanupWorker: stopped");
}

async function run() {
  logger.info("cleanupWorker: run - housekeeping starting");
  try {
    // 1. Mark stale pending payments as failed
    const staleMs = Date.now() - STALE_PAYMENT_HOURS * 60 * 60 * 1000;
    const res = await Payment.updateMany(
      { status: "pending", createdAt: { $lte: new Date(staleMs) } },
      { $set: { status: "failed", processedAt: Date.now() } }
    ).exec();
    logger.info("cleanupWorker: stale payments marked", {
      modified: (res as any).nModified ?? (res as any).modifiedCount,
    });

    // 2. Delete old SMS
    const deleteBefore = new Date(Date.now() - DELETE_SMS_OLDER_DAYS * 24 * 60 * 60 * 1000);
    const delRes = await Sms.deleteMany({ createdAt: { $lte: deleteBefore } }).exec();
    logger.info("cleanupWorker: old sms deleted", {
      deleted: (delRes as any).deletedCount ?? (delRes as any).n,
    });

    // 3. Auto-delete contacts older than 24 hours
    try {
      const Contact = (await import("../models/Contact")).default;
      const contactCutoff = new Date(Date.now() - DELETE_CONTACTS_OLDER_HOURS * 60 * 60 * 1000);
      const contactDel = await Contact.deleteMany({ createdAt: { $lte: contactCutoff } }).exec();
      const contactCount = (contactDel as any).deletedCount ?? (contactDel as any).n ?? 0;
      if (contactCount > 0) {
        logger.info("cleanupWorker: old contacts deleted", { deleted: contactCount });
      }
    } catch (contactErr: any) {
      logger.warn("cleanupWorker: contacts cleanup failed", { error: contactErr?.message });
    }
  } catch (e) {
    logger.error("cleanupWorker: run error", e);
  } finally {
    logger.info("cleanupWorker: run - finished");
  }
}
