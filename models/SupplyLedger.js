import mongoose from "mongoose";

// ── SupplyLedger ──────────────────────────────────────────────────────────────
// An append-only record of stock that was taken from one client's holding and
// given to another. "Owed" is never stored as a number you edit. It is worked
// out by adding up qtyChange for each (client, partNumber):
//
//   qtyChange < 0  -> stock was taken (we owe that client more)
//   qtyChange > 0  -> stock was replaced or the supply entry was deleted
//
// Never update or delete rows here. Fix mistakes by adding a new row.
// (The one exception is routes/supply.js undoing a row it only just inserted
// when the matching supply entry failed to save.)
const SupplyLedgerSchema = new mongoose.Schema(
  {
    // the client who is OWED (the one the stock was taken FROM)
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    partNumber: {
      type: String,
      required: true,
      trim: true,
      set: (v) => String(v ?? "").trim().toUpperCase(),
    },
    goodsSupplied: { type: String, trim: true, default: "" },
    qtyChange: { type: Number, required: true },
    type: { type: String, enum: ["borrowed_out", "settled", "reversed"], required: true },
    relatedSupply: { type: mongoose.Schema.Types.ObjectId, ref: "Supply", default: null },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  // only createdAt: rows are never edited, so there is no updatedAt
  { timestamps: { createdAt: true, updatedAt: false } }
);

SupplyLedgerSchema.index({ client: 1, partNumber: 1 });
SupplyLedgerSchema.index({ relatedSupply: 1 });

export default mongoose.model("SupplyLedger", SupplyLedgerSchema);
