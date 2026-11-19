import Schedule from "../models/Schedule.js";

export const COMPLETED_RETENTION_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Soft-removes completed schedules older than the retention window. Nothing is
// deleted, so the history stays available for audits. Safe to run any number of
// times. GET /schedules also filters by date on every request, so a row still
// disappears on time even if this job is late or the server was down.
export const archiveOldSchedules = async () => {
  const cutoff = new Date(Date.now() - COMPLETED_RETENTION_DAYS * DAY_MS);
  const result = await Schedule.updateMany(
    { status: "completed", archivedAt: null, completedAt: { $lte: cutoff } },
    { $set: { archivedAt: new Date() } }
  );
  return result.modifiedCount;
};

// Runs once at startup, then every hour. No extra package needed.
export const startScheduleArchiver = () => {
  const run = async () => {
    try {
      const count = await archiveOldSchedules();
      if (count) console.log(`[schedules] archived ${count} completed schedule(s)`);
    } catch (err) {
      console.error("[schedules] archive job failed:", err.message);
    }
  };
  run();
  const timer = setInterval(run, HOUR_MS);
  timer.unref?.(); // don't keep the process alive just for this timer
};
