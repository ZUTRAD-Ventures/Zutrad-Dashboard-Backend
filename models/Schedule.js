import mongoose from "mongoose";

// ── Schedule ──────────────────────────────────────────────────────────────────
// Tasks an administrator hands to a team member. There is deliberately no edit
// or delete route: completed and archived rows are the audit trail.
const ScheduleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: ["pending", "completed"], default: "pending" },

    // set from the login token, never from the request body
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // set by the server when the task is completed
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // set by the cleanup job (jobs/archiveSchedules.js) 21 days after completion
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ScheduleSchema.index({ status: 1, completedAt: 1 });
ScheduleSchema.index({ archivedAt: 1 });
ScheduleSchema.index({ assignedTo: 1 });

export default mongoose.model("Schedule", ScheduleSchema);
