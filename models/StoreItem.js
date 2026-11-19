import mongoose from "mongoose";

// Machine names exactly as the frontend shows them, plus older names the app
// also knows about. Any casing is accepted when saving ("MACSA ID" and
// "Macsa ID" both become "Macsa ID"), and the same form is returned when reading,
// so the Store page's machine tabs always match.
export const MACHINE_TYPES = ["Macsa ID", "Savema", "Sojet", "BestCode", "HITACHI", "EIDOS", "MARKEM IMARJE"];

export const canonicalMachine = (value) => {
  if (typeof value !== "string") return value;
  const key = value.trim().toUpperCase();
  return MACHINE_TYPES.find((m) => m.toUpperCase() === key) ?? value;
};

const storeItemSchema = new mongoose.Schema(
  {
    serialNumber: { type: String, required: true, unique: true, trim: true },
    // Optional. Trim + uppercase so "pr-1001 " and "PR-1001" are the same.
    // Supply and the owed ledger identify a part by serialNumber, not this.
    partNumber: {
      type: String,
      required: false,
      default: "",
      trim: true,
      set: (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    },
    machinePart: { type: String, required: true, trim: true },
    machine: {
      type: String,
      required: true,
      enum: MACHINE_TYPES,
      set: canonicalMachine,
      get: canonicalMachine,
    },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    // The client this part belongs to. Empty means general stock.
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
  },
  { timestamps: true, toJSON: { getters: true } }
);

export default mongoose.model("StoreItem", storeItemSchema);