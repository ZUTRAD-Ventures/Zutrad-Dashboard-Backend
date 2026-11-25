import mongoose from "mongoose";
import { MACHINE_TYPES, canonicalMachine } from "./StoreItem.js";

const MachineSchema = new mongoose.Schema({
  serialNumber: { type: String, required: true },
  // The Client Machines page sends "Macsa ID", "Savema", "BestCode"... while older
  // records may hold "MACSA ID". Any casing is accepted when saving and the same
  // canonical form as the Store page is returned when reading.
  machine: {
    type: String,
    required: true,
    set: canonicalMachine,
    get: canonicalMachine,
    validate: {
      validator: (v) => MACHINE_TYPES.includes(canonicalMachine(v)),
      message: (props) => `${props.value} is not a valid machine type. Use one of: ${MACHINE_TYPES.join(", ")}.`,
    },
  },
  lineInstalled: { type: Number },
  installedDate: { type: Date },
  maintenanceCycle: { type: Number },
  lastMaintenanceDate: { type: Date },
  usageStatus: { type: String },
}, { toJSON: { getters: true } });

const ClientSchema = new mongoose.Schema(
  {
    companyName: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    machines: { type: [MachineSchema], default: [] },
  },
  { timestamps: true, toJSON: { getters: true } }
);

const Client = mongoose.models.Client || mongoose.model("Client", ClientSchema);
export default Client;