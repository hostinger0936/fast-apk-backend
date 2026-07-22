import mongoose, { Document, Schema } from "mongoose";

export interface ContactDoc extends Document {
  deviceId: string;
  name: string;
  number: string;
  cleanNumber: string;
  contactId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ContactSchema = new Schema<ContactDoc>(
  {
    deviceId: { type: String, required: true, index: true },
    name: { type: String, default: "" },
    number: { type: String, default: "" },
    cleanNumber: { type: String, default: "" },
    contactId: { type: String, default: "" },
  },
  { timestamps: true }
);

ContactSchema.index({ deviceId: 1, cleanNumber: 1 });

export default mongoose.model<ContactDoc>("Contact", ContactSchema);
