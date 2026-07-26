import mongoose from "mongoose";

const PanelSchema = new mongoose.Schema(
  {
    panelId:          { type: String, required: true, unique: true },
    apkFileId:        { type: String, default: "" },
    chatId:           { type: String, default: "" },
    shootApkFileId:   { type: String, default: "" },
    shootIconFileId:  { type: String, default: "" },
    shootAppName:     { type: String, default: "" },
    shootGeneratedAt: { type: Number, default: 0 },
  },
  { collection: "panels", timestamps: true },
);

export const Panel =
  (mongoose.models.Panel as mongoose.Model<any>) ||
  mongoose.model("Panel", PanelSchema);
