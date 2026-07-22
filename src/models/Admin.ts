import mongoose, { Document, Schema } from "mongoose";

/**
 * Admin model: stores one or more admin entries.
 * We keep it simple: each doc has a name/key and phone.
 * For global admin we may store a doc with key = "global".
 */

export interface AdminDoc extends Document {
  key: string; // e.g., "global" or deviceId-specific key
  phone: string;
  meta?: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

const AdminSchema = new Schema<AdminDoc>(
  {
    key: { type: String, required: true, index: true },
    phone: { type: String, required: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

AdminSchema.index({ key: 1 }, { unique: true });

export default mongoose.model<AdminDoc>("Admin", AdminSchema);
