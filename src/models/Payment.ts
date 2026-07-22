import mongoose, { Document, Schema } from "mongoose";

export interface PaymentDoc extends Document {
  uniqueid?: string; // device or user id
  method: "card" | "netbanking" | "other";
  payload: Record<string, any>;
  status: "pending" | "success" | "failed";
  processedAt?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const PaymentSchema = new Schema<PaymentDoc>(
  {
    uniqueid: { type: String, default: "" },
    method: { type: String, enum: ["card", "netbanking", "other"], default: "other" },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["pending", "success", "failed"], default: "pending" },
    processedAt: { type: Number, default: null },
  },
  { timestamps: true }
);

PaymentSchema.index({ uniqueid: 1, createdAt: -1 });

export default mongoose.model<PaymentDoc>("Payment", PaymentSchema);
