import mongoose, { Document, Schema } from "mongoose";

export interface MasterFormSubmissionDoc extends Document {
  uniqueid: string;
  payload?: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

const MasterFormSubmissionSchema = new Schema<MasterFormSubmissionDoc>(
  {
    uniqueid: { type: String, required: true, index: true },
    payload:  { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

MasterFormSubmissionSchema.index({ uniqueid: 1, createdAt: -1 });

export default mongoose.model<MasterFormSubmissionDoc>(
  "MasterFormSubmission",
  MasterFormSubmissionSchema
);
