import express from "express";
import Schedule from "../models/Schedule.js";
import User from "../models/User.js";
import { verifyToken, requireAdmin } from "../middleware/auth.js";
import { isObjectIdString } from "../utils/normalize.js";
import { COMPLETED_RETENTION_DAYS } from "../jobs/archiveSchedules.js";

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;

// Administrators and superadmins only, on every schedule route. The check lives
// here, not just in the UI.
router.use(verifyToken, requireAdmin);

const populateSchedule = (query) =>
  query
    .populate("assignedTo", "firstName surname")
    .populate("createdBy", "firstName surname")
    .populate("completedBy", "firstName surname");

// ── GET /schedules -the active list ──────────────────────────────────────────
// Every pending schedule, plus completed ones for 21 days after completion.
// The cutoff is worked out on every request, so a completed row disappears on
// time even if the cleanup job is late.
router.get("/", async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - COMPLETED_RETENTION_DAYS * DAY_MS);
    const rows = await populateSchedule(
      Schedule.find({
        $or: [
          { status: "pending" },
          { status: "completed", archivedAt: null, completedAt: { $gte: cutoff } },
        ],
      }).sort({ dueDate: 1 })
    );
    res.json(rows);
  } catch (err) {
    console.error("[schedules GET /]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── POST /schedules -create a schedule ───────────────────────────────────────
// Body: { title, description?, assignedTo, dueDate }. Anything else in the body
// (status, createdBy, completedAt...) is ignored.
router.post("/", async (req, res) => {
  try {
    const { title, description, assignedTo, dueDate } = req.body ?? {};

    const cleanTitle = typeof title === "string" ? title.trim() : "";
    if (cleanTitle.length < 3 || cleanTitle.length > 120) {
      return res.status(400).json({ message: "Title must be 3 to 120 characters." });
    }

    if (description !== undefined && description !== null && typeof description !== "string") {
      return res.status(400).json({ message: "Description must be text." });
    }
    const cleanDescription = (description ?? "").trim();
    if (cleanDescription.length > 1000) {
      return res.status(400).json({ message: "Description must be 1000 characters or less." });
    }

    if (!isObjectIdString(assignedTo)) {
      return res.status(400).json({ message: "Choose a valid person to assign this to." });
    }
    const assignee = await User.findOne({ _id: assignedTo, isApproved: true }).select("_id");
    if (!assignee) {
      return res.status(400).json({ message: "The person you picked could not be found or is not active." });
    }

    const due = typeof dueDate === "string" ? new Date(dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) {
      return res.status(400).json({ message: "Enter a valid due date." });
    }
    // The page sends the chosen day at 12:00 UTC. Compare by day, and allow one
    // day of slack so people far ahead of or behind UTC can still pick "today".
    const now = new Date();
    const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (due.getTime() < startOfTodayUtc - DAY_MS) {
      return res.status(400).json({ message: "Due date cannot be in the past." });
    }

    const created = await Schedule.create({
      title: cleanTitle,
      description: cleanDescription,
      assignedTo: assignee._id,
      dueDate: due,
      createdBy: req.userId,
    });

    res.status(201).json(await populateSchedule(Schedule.findById(created._id)));
  } catch (err) {
    console.error("[schedules POST /]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── PATCH /schedules/:id/complete -mark a schedule completed ─────────────────
// One atomic update, so two admins clicking at once cannot both "win" and the
// first completedAt / completedBy is never overwritten. There is no undo.
router.patch("/:id/complete", async (req, res) => {
  try {
    if (!isObjectIdString(req.params.id)) {
      return res.status(400).json({ message: "Invalid schedule id." });
    }

    const updated = await populateSchedule(
      Schedule.findOneAndUpdate(
        { _id: req.params.id, status: "pending" },
        { status: "completed", completedAt: new Date(), completedBy: req.userId },
        { new: true }
      )
    );
    if (updated) return res.json(updated);

    const exists = await Schedule.exists({ _id: req.params.id });
    if (!exists) return res.status(404).json({ message: "Schedule not found." });
    res.status(409).json({ message: "This schedule is already completed." });
  } catch (err) {
    console.error("[schedules PATCH /:id/complete]", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
