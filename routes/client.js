import mongoose from "mongoose";
import express from "express";
import Client from "../models/Client.js";
import { verifyToken, requireSuperAdmin } from "../middleware/auth.js";
import { MACHINE_TYPES, canonicalMachine } from "../models/StoreItem.js";
import { exactCI, isObjectIdString } from "../utils/normalize.js";

const router = express.Router();

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const canEditMachine = (req) => {
  return req.userRole === "superadmin" || req.userRole === "administrator" || req.userPermissions?.includes("maintenance");
};

const requireMachineEditor = (req, res, next) => {
  if (!canEditMachine(req)) {
    return res.status(403).json({ message: "Access denied." });
  }
  next();
};

const findDuplicateMachineSerial = async (serialNumber, { excludeClientId, excludeMachineId } = {}) => {
  const normalizedSerial = String(serialNumber || "").trim();
  if (!normalizedSerial) return null;

  const matchingClients = await Client.find({
    "machines.serialNumber": { $regex: new RegExp(`^${escapeRegExp(normalizedSerial)}$`, "i") },
  }).select("_id machines");

  return matchingClients.find((client) =>
    client._id.toString() !== excludeClientId &&
    client.machines.some((machine) => {
      const sameSerial = machine.serialNumber && machine.serialNumber.toLowerCase() === normalizedSerial.toLowerCase();
      const sameMachine = excludeMachineId && machine._id && machine._id.toString() === excludeMachineId;
      return sameSerial && !sameMachine;
    })
  );
};

const resolveClientDocument = async (input) => {
  if (input === undefined || input === null || input === "") return null;

  if (mongoose.Types.ObjectId.isValid(input)) {
    return Client.findById(input);
  }

  const normalizedInput = String(input).trim();
  if (!normalizedInput) return null;

  if (/^\d+$/.test(normalizedInput)) {
    const index = Number(normalizedInput);
    if (Number.isInteger(index) && index > 0) {
      const clients = await Client.find().sort({ createdAt: 1 }).select("_id");
      const client = clients[index - 1];
      if (client) return Client.findById(client._id);
    }
    return null;
  }

  return Client.findOne({
    companyName: { $regex: new RegExp(`^${escapeRegExp(normalizedInput)}$`, "i") },
  });
};

// GET /clients -list all clients
router.get("/", async (req, res) => {
  try {
    const clients = await Client.find().sort({ createdAt: -1 });
    res.json(clients);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /clients/:id -fetch one client by id, numeric index or company name
router.get("/:id", async (req, res) => {
  try {
    const client = await resolveClientDocument(req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST /clients -create a client
router.post("/", async (req, res) => {
  try {
    const client = await Client.create(req.body);
    res.status(201).json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /clients/:id -update a client's top-level fields
router.put("/:id", async (req, res) => {
  try {
    const existingClient = await resolveClientDocument(req.params.id);
    if (!existingClient) return res.status(404).json({ message: "Client not found" });

    const client = await Client.findByIdAndUpdate(existingClient._id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /clients/:id -delete a client and all its machines (superadmin only)
router.delete("/:id", verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const existingClient = await resolveClientDocument(req.params.id);
    if (!existingClient) return res.status(404).json({ message: "Client not found" });

    const client = await Client.findByIdAndDelete(existingClient._id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json({ message: "Client deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /clients/machines/bulk -import many machines at once (Excel / CSV) ──
// Body: { items: [{ serialNumber, client, machine, lineInstalled, installedDate,
//                   maintenanceCycle, lastMaintenanceDate? }] }
// `client` is a client id or an exact company name. installedDate and
// lastMaintenanceDate are "YYYY-MM-DD". lastMaintenanceDate defaults to the
// installation date.
// Max 500 items per request. If any entry is invalid or its serial number
// already exists (on any client), nothing is saved and the message names the
// entry. Responds 201 { created, clients: [<updated client>, ...] }.
// (No clash with POST /:id/machines: that path's second segment is "machines".)
// Imports are superadmin only.
const requireBulkImporter = requireSuperAdmin;

const cleanText = (value, max) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text && text.length <= max ? text : null;
};

const toPositiveInt = (value) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

// "YYYY-MM-DD" → Date (UTC midnight) or null when missing/invalid (e.g. 2020-02-31).
const parseIsoDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const iso = value.trim();
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : date;
};

// Accepts a client id or an exact company name; throws when nothing matches.
const resolveClientId = async (input) => {
  const value = String(input).trim();
  if (isObjectIdString(value)) {
    const byId = await Client.findById(value).select("_id");
    if (byId) return byId._id.toString();
  }
  const byName = await Client.findOne({ companyName: exactCI(value) }).select("_id");
  if (byName) return byName._id.toString();
  throw new Error(`Client "${value}" not found.`);
};

router.post("/machines/bulk", verifyToken, requireBulkImporter, async (req, res) => {
  try {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items must be a non-empty array." });
    }
    if (items.length > 500) {
      return res.status(400).json({ message: "A single import request can hold at most 500 items." });
    }

    const prepared = []; // { clientId, machine }
    const seenSerials = new Set();
    const clientCache = new Map(); // client text -> id, so each name is looked up once

    for (let i = 0; i < items.length; i++) {
      const label = `Entry ${i + 1}`;
      const it = items[i];
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        return res.status(400).json({ message: `${label}: must be an object.` });
      }
      const fail = (msg) => res.status(400).json({ message: `${label}: ${msg}` });

      const serialNumber = cleanText(it.serialNumber, 100);
      if (!serialNumber) return fail("serial number is required (max 100 characters).");

      const clientText = cleanText(it.client ?? it.clientId, 200);
      if (!clientText) return fail("client is required.");

      const machineType = canonicalMachine(typeof it.machine === "string" ? it.machine.trim() : "");
      if (!MACHINE_TYPES.includes(machineType)) return fail(`machine must be one of ${MACHINE_TYPES.join(", ")}.`);

      const lineInstalled = toPositiveInt(it.lineInstalled);
      if (lineInstalled === null) return fail("line number must be a whole number of 1 or more.");

      const installedDate = parseIsoDate(it.installedDate);
      if (!installedDate) return fail("installation date is required (YYYY-MM-DD).");

      const maintenanceCycle = toPositiveInt(it.maintenanceCycle);
      if (maintenanceCycle === null) return fail("maintenance cycle must be a whole number of months, 1 or more.");

      let lastMaintenanceDate = installedDate;
      if (it.lastMaintenanceDate !== undefined && it.lastMaintenanceDate !== null && it.lastMaintenanceDate !== "") {
        lastMaintenanceDate = parseIsoDate(it.lastMaintenanceDate);
        if (!lastMaintenanceDate) return fail("last maintenance date must be a valid date (YYYY-MM-DD).");
      }

      const key = serialNumber.toLowerCase();
      if (seenSerials.has(key)) return fail(`serial number "${serialNumber}" appears more than once in this import.`);
      seenSerials.add(key);

      const cacheKey = clientText.toLowerCase();
      if (!clientCache.has(cacheKey)) {
        try {
          clientCache.set(cacheKey, await resolveClientId(clientText));
        } catch (clientErr) {
          return fail(clientErr.message);
        }
      }

      prepared.push({
        clientId: clientCache.get(cacheKey),
        machine: {
          serialNumber,
          machine: machineType,
          lineInstalled,
          installedDate,
          maintenanceCycle,
          lastMaintenanceDate,
        },
      });
    }

    // serial numbers must be unique across every client (case-insensitive)
    const existingRows = await Client.aggregate([
      { $unwind: "$machines" },
      { $project: { _id: 0, serial: "$machines.serialNumber" } },
    ]);
    const taken = new Set(existingRows.map((r) => String(r.serial ?? "").trim().toLowerCase()));
    const clash = prepared.findIndex((p) => taken.has(p.machine.serialNumber.toLowerCase()));
    if (clash !== -1) {
      return res.status(409).json({
        message: `Entry ${clash + 1}: a machine with serial number "${prepared[clash].machine.serialNumber}" already exists.`,
      });
    }

    // group by client, add to each client's document in memory, validate every
    // document first, and only then save, so a bad row never leaves a half import
    const byClient = new Map();
    prepared.forEach((p) => {
      if (!byClient.has(p.clientId)) byClient.set(p.clientId, []);
      byClient.get(p.clientId).push(p.machine);
    });

    const clientDocs = await Client.find({ _id: { $in: [...byClient.keys()] } });
    if (clientDocs.length !== byClient.size) {
      return res.status(404).json({ message: "One of the clients no longer exists. Refresh the page and try again." });
    }
    clientDocs.forEach((doc) => doc.machines.push(...byClient.get(doc._id.toString())));
    await Promise.all(clientDocs.map((doc) => doc.validate()));
    for (const doc of clientDocs) await doc.save();

    res.status(201).json({ created: prepared.length, clients: clientDocs });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    console.error("[clients POST /machines/bulk]", err);
    res.status(500).json({ message: err.message });
  }
});

// POST /clients/:id/machines -add a machine to a client
router.post("/:id/machines", async (req, res) => {
  try {
    const client = await resolveClientDocument(req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const duplicate = await findDuplicateMachineSerial(req.body?.serialNumber);
    if (duplicate) {
      return res.status(409).json({ message: "A machine with this serial number already exists." });
    }

    client.machines.push(req.body);
    await client.save();
    res.status(201).json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /clients/:id/machines/:machineId -update one machine's fields
router.put("/:id/machines/:machineId", verifyToken, requireMachineEditor, async (req, res) => {
  try {
    const client = await resolveClientDocument(req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const machine = client.machines.id(req.params.machineId);
    if (!machine) return res.status(404).json({ message: "Machine not found" });

    if (req.body?.serialNumber !== undefined) {
      const duplicate = await findDuplicateMachineSerial(req.body.serialNumber, {
        excludeClientId: client._id.toString(),
        excludeMachineId: req.params.machineId,
      });
      if (duplicate) {
        return res.status(409).json({ message: "A machine with this serial number already exists." });
      }
    }

    Object.assign(machine, req.body);
    await client.save();
    res.json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /clients/:id/machines/:machineId -remove one machine (superadmin only)
router.delete("/:id/machines/:machineId", verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const client = await resolveClientDocument(req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const beforeCount = client.machines.length;
    client.machines = client.machines.filter((m) => m._id.toString() !== req.params.machineId);
    const afterCount = client.machines.length;
    console.log(`Deleting machine ${req.params.machineId} from client ${client._id}. removed=${beforeCount - afterCount}`);
    await client.save();
    res.json(client);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;