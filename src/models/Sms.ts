import mongoose, { Document, Schema } from "mongoose";
export interface SmsDoc extends Document {
  deviceId: string;
  sender: string;
  senderNumber?: string;
  receiver: string;
  title?: string;
  body: string;
  timestamp: number;
  createdAt?: Date;
  updatedAt?: Date;
  meta?: Record<string, any>;
}
const SmsSchema = new Schema<SmsDoc>(
  {
    deviceId: { type: String, required: true, index: true },
    sender: { type: String, required: true },
    senderNumber: { type: String, default: "" },
    receiver: { type: String, default: "" },
    title: { type: String, default: "" },
    body: { type: String, required: true },
    timestamp: { type: Number, required: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
SmsSchema.index({ deviceId: 1, timestamp: -1 });
export default mongoose.model<SmsDoc>("Sms", SmsSchema);
