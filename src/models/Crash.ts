import mongoose, { Document, Schema } from "mongoose";

export interface CrashDoc extends Document {
  deviceId?: string;
  uniqueid?: string;
  title?: string;
  body?: Record<string, any>;
  timestamp?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const CrashSchema = new Schema<CrashDoc>(
  {
    deviceId: { type: String, default: "" },
    uniqueid: { type: String, default: "" },
    title: { type: String, default: "crash" },
    body: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Number, default: Date.now },
  },
  { timestamps: true }
);

CrashSchema.index({ deviceId: 1, createdAt: -1 });

export default mongoose.model<CrashDoc>("Crash", CrashSchema);
