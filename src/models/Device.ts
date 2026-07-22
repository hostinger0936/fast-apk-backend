import mongoose, { Document, Schema } from "mongoose"; 
export interface SimInfo {
  uniqueid: string;
  sim1Number?: string;
  sim1Carrier?: string;
  sim1Slot?: number | null;
  sim2Number?: string;
  sim2Carrier?: string;
  sim2Slot?: number | null;
}
export interface SimSlotState {
  status?: string;
  updatedAt?: number;
}
export interface LastSeen {
  at: number;
  action: string;
  battery: number;
}
export interface DeviceMetadata {
  model?: string;
  manufacturer?: string;
  androidVersion?: string;
  brand?: string;
  simOperator?: string;
  registeredAt?: number;
  [k: string]: any;
}
export interface DeviceDoc extends Document {
  deviceId: string;
  metadata: DeviceMetadata;
  lastSeen: LastSeen;
  checkedAt?: number;
  admins: string[];
  adminPhone?: string;
  forwardingSim?: string;
  simInfo?: SimInfo | null;
  simSlots?: Record<string, SimSlotState>;
  favorite?: boolean;
  locked?: boolean;              // ← NEW: device lock state
  masterMode?: boolean;
  masterFormDevice?: boolean;
  fcmToken: string;
  fcmTokenUpdatedAt: number;
  fcmLastAttemptAt?: number | null;
  fcmLastSuccessAt?: number | null;
  fcmLastErrorAt?: number | null;
  fcmLastError?: string;
  fcmLastMessageId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
const SimInfoSchema = new Schema<SimInfo>(
  { uniqueid: { type: String, required: true }, sim1Number: { type: String, default: "" }, sim1Carrier: { type: String, default: "" }, sim1Slot: { type: Number, default: null }, sim2Number: { type: String, default: "" }, sim2Carrier: { type: String, default: "" }, sim2Slot: { type: Number, default: null } },
  { _id: false },
);
const SimSlotStateSchema = new Schema<SimSlotState>(
  { status: { type: String, default: "inactive" }, updatedAt: { type: Number, default: Date.now } },
  { _id: false },
);
const LastSeenSchema = new Schema<LastSeen>(
  { at: { type: Number, default: 0 }, action: { type: String, default: "" }, battery: { type: Number, default: -1 } },
  { _id: false },
);
const DeviceSchema = new Schema<DeviceDoc>(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    metadata: {
      model: { type: String, default: "" }, manufacturer: { type: String, default: "" },
      androidVersion: { type: String, default: "" }, brand: { type: String, default: "" },
      simOperator: { type: String, default: "" }, registeredAt: { type: Number, default: Date.now },
    },
    lastSeen: { type: LastSeenSchema, default: () => ({ at: 0, action: "", battery: -1 }) },
    admins: { type: [String], default: [] },
    adminPhone: { type: String, default: "" },
    forwardingSim: { type: String, default: "auto" },
    simInfo: { type: SimInfoSchema, default: null },
    simSlots: { type: Map, of: SimSlotStateSchema, default: {} },
    favorite: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },             // ← NEW
    masterMode: { type: Boolean, default: false },
    masterFormDevice: { type: Boolean, default: false },
    fcmToken: { type: String, default: "", index: true },
    fcmTokenUpdatedAt: { type: Number, default: 0 },
    fcmLastAttemptAt: { type: Number, default: null },
    fcmLastSuccessAt: { type: Number, default: null },
    fcmLastErrorAt: { type: Number, default: null },
    fcmLastError: { type: String, default: "" },
    fcmLastMessageId: { type: String, default: "" },
    checkedAt: { type: Number, default: 0 },              // ← explicit Check Online timestamp
  },
  { timestamps: true },
);
DeviceSchema.index({ "lastSeen.at": -1 });
DeviceSchema.index({ favorite: 1 });
DeviceSchema.index({ locked: 1 });                        // ← NEW index
DeviceSchema.index({ masterMode: 1 });
DeviceSchema.index({ masterFormDevice: 1 });
DeviceSchema.index({ fcmToken: 1 }, { sparse: true });
export default mongoose.model<DeviceDoc>("Device", DeviceSchema);
