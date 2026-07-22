import mongoose from "mongoose";

const PanelSchema = new mongoose.Schema(
  {
    panelId:   { type: String, required: true, unique: true },
    apkFileId: { type: String, default: "" },
    chatId:    { type: String, default: "" },
  },
  { collection: "panels", timestamps: true },
);

export const Panel =
  (mongoose.models.Panel as mongoose.Model<any>) ||
  mongoose.model("Panel", PanelSchema);
