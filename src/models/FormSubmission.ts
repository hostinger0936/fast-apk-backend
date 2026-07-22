import mongoose, { Document, Schema } from "mongoose";

export interface FormSubmissionDoc extends Document {
  uniqueid: string;
  payload?: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

const FormSubmissionSchema = new Schema<FormSubmissionDoc>(
  {
    uniqueid: { type: String, required: true, index: true },
    // flexible payload — accepts any android form shape
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// index to allow quick lookup per device/user
FormSubmissionSchema.index({ uniqueid: 1, createdAt: -1 });

export default mongoose.model<FormSubmissionDoc>(
  "FormSubmission",
  FormSubmissionSchema
);