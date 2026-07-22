import express from "express";
import devicesRouter from "./devices";
import adminRouter from "./admin";
import formsRouter from "./forms";

const router = express.Router();

// Mount routers: /api/devices -> devicesRouter
router.use("/devices", devicesRouter);

// Admin-related routes -> /api/admin/*
router.use("/admin", adminRouter);

// Form/payment endpoints (kept at /api/)
router.use("/", formsRouter);

export default router;
