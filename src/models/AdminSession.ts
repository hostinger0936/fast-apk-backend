import mongoose, { Schema, Document } from "mongoose";

export interface AdminSessionDoc extends Document {
  sessionId: string;
  admin: string;
  deviceId: string;
  userAgent: string;
  ip: string;
  browser: string;
  os: string;
  lastSeen: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const AdminSessionSchema = new Schema<AdminSessionDoc>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    admin: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
    browser: { type: String, default: "" },
    os: { type: String, default: "" },
    lastSeen: { type: Number, default: Date.now },
  },
  { timestamps: true },
);

// Non-unique compound index for queries
AdminSessionSchema.index({ admin: 1, deviceId: 1 });

const AdminSession = mongoose.model<AdminSessionDoc>("AdminSession", AdminSessionSchema);

/**
 * AUTO-FIX: Drop old unique index that causes session merging.
 * Runs once on server start. Safe to call multiple times.
 * If index doesn't exist, silently ignores.
 */
(async () => {
  try {
    const collection = AdminSession.collection;

    // Wait for connection
    if (mongoose.connection.readyState !== 1) {
      await new Promise<void>((resolve) => {
        mongoose.connection.once("connected", resolve);
        mongoose.connection.once("open", resolve);
        // Timeout after 30s
        setTimeout(resolve, 30000);
      });
    }

    const indexes = await collection.indexes();

    for (const idx of indexes) {
      // Find the old problematic unique index
      if (
        idx.unique === true &&
        idx.key &&
        idx.key.admin !== undefined &&
        idx.key.deviceId !== undefined &&
        !idx.key.sessionId
      ) {
        console.log(`[AdminSession] Dropping old unique index: ${idx.name}`);
        await collection.dropIndex(idx.name!);
        console.log(`[AdminSession] Old index "${idx.name}" dropped successfully`);
      }
    }
  } catch (err: any) {
    // Index might not exist — that's fine
    if (err?.codeName !== "IndexNotFound" && err?.code !== 27) {
      console.warn(`[AdminSession] Index cleanup warning: ${err?.message || err}`);
    }
  }
})();

export default AdminSession;
