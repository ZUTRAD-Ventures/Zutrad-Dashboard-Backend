import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Supply from "../models/Supply.js";
import StoreItem from "../models/StoreItem.js";
import Client from "../models/Client.js";
import SupplyLedger from "../models/SupplyLedger.js";
import { normalizeSerial, exactCI, isObjectIdString, withId } from "../utils/normalize.js";
import { verifyToken, requirePermission, requireAdmin, requireSuperAdmin, requireAnyPermission } from "../middleware/auth.js";

const router = express.Router();

// ── resolve __dirname in ES modules ──────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── upload directory -created at startup if missing ─────────────────────────
const UPLOAD_DIR = path.join(__dirname, "../../uploads/supply");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── multer -disk storage with unique filenames to avoid collisions ───────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req,  file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
  fileFilter: (_req, file, cb) => {
    const BLOCKED = /\.(exe|sh|bat|cmd|ps1|msi|dll|so)$/i;
    if (BLOCKED.test(file.originalname)) {
      return cb(new Error(`File type not allowed: ${file.originalname}`));
    }
    cb(null, true);
  },
});

// ── handleUpload ───────────────────────────────────────────────────────────────
// Wraps multer so that ANY upload error (MulterError, blocked file type, file
// too large, etc.) is returned as a proper JSON 400 response instead of
// triggering Express's default HTML error page -which would cause the frontend
// to receive non-JSON and show "Server returned an unexpected response".
const handleUpload = (req, res, next) => {
  upload.array("files", 20)(req, res, (err) => {
    if (!err) return next();

    // Log the real error server-side so it's easy to diagnose in the console.
    console.error("[supply upload error]", err.message);

    if (err instanceof multer.MulterError) {
      // e.g. LIMIT_FILE_SIZE, LIMIT_FILE_COUNT, LIMIT_UNEXPECTED_FILE
      const messages = {
        LIMIT_FILE_SIZE:   "One or more files exceed the 10 MB size limit.",
        LIMIT_FILE_COUNT:  "You can attach a maximum of 20 files per entry.",
        LIMIT_UNEXPECTED_FILE: "Unexpected file field. Use the field name \"files\".",
      };
      return res.status(400).json({
        message: messages[err.code] || `Upload error: ${err.message}`,
      });
    }

    // Custom fileFilter error or any other upload problem
    return res.status(400).json({ message: err.message || "File upload failed." });
  });
};

// ── populate helper ───────────────────────────────────────────────────────────
const populateSupply = (query) =>
  query
    .populate("user",   "firstName surname")
    .populate("client", "companyName")
    .populate("takenFrom", "companyName")
    .populate("storeItem", "machinePart serialNumber quantity");

// Plain object with `id` added next to `_id` on client / takenFrom (the table
// reads both). takenFrom is null when stock did not come from another client.
const serializeSupply = (row) => ({
  ...row,
  client: withId(row.client),
  takenFrom: withId(row.takenFrom),
});

const canRecordTransfers = (req) =>
  req.userRole === "administrator" || req.userRole === "superadmin";

// Sum of qtyChange for one client + serial number. Negative means we owe that client.
const ledgerTotal = async (clientId, serial) => {
  const [row] = await SupplyLedger.aggregate([
    { $match: { client: clientId, serialNumber: serial } },
    { $group: { _id: null, total: { $sum: "$qtyChange" } } },
  ]);
  return row ? row.total : 0;
};

// Undo the ledger effect of deleted supply entries. Adds a "reversed" row for
// each borrowed_out row (history is kept, never deleted). Safe to call twice.
const reverseTransfers = async (supplyIds, userId) => {
  if (!supplyIds.length) return;
  const borrowed = await SupplyLedger.find({ relatedSupply: { $in: supplyIds }, type: "borrowed_out" });
  if (!borrowed.length) return;
  const reversed = await SupplyLedger.find({ relatedSupply: { $in: supplyIds }, type: "reversed" }).select("relatedSupply");
  const done = new Set(reversed.map((r) => String(r.relatedSupply)));
  const rows = borrowed
    .filter((r) => !done.has(String(r.relatedSupply)))
    .map((r) => ({
      client: r.client,
      serialNumber: r.serialNumber,
      goodsSupplied: r.goodsSupplied,
      qtyChange: Math.abs(r.qtyChange),
      type: "reversed",
      relatedSupply: r.relatedSupply,
      note: "Supply entry deleted",
      createdBy: userId,
    }));
  if (rows.length) await SupplyLedger.insertMany(rows);
};

const resolveClientReference = async (clientId) => {
  if (clientId === undefined || clientId === null || clientId === "") {
    throw new Error("Client is required.");
  }

  if (mongoose.Types.ObjectId.isValid(clientId)) {
    const client = await Client.findById(clientId);
    if (client) return client._id;
  }

  if (typeof clientId === "number" || /^\d+$/.test(String(clientId))) {
    const index = Number(clientId);
    if (Number.isInteger(index) && index > 0) {
      const clients = await Client.find().sort({ createdAt: 1 }).select("_id");
      const matchedClient = clients[index - 1];
      if (matchedClient) return matchedClient._id;
    }
  }

  const client = await Client.findOne({
    companyName: { $regex: new RegExp(`^${String(clientId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
  });

  if (client) return client._id;

  throw new Error("Client not found.");
};

// ── GET /supply -list all supply log entries, newest first ──────────────────
router.get("/", verifyToken, async (req, res) => {
  try {
    const rows = await populateSupply(Supply.find().sort({ createdAt: -1 })).lean();
    res.json(rows.map(serializeSupply));
  } catch (err) {
    console.error("[supply GET /]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── GET /supply/files/:filename -download an attachment ─────────────────────
// MUST be registered before /:id routes so Express doesn't treat "files" as
// an id parameter.
// Users with store or supply permissions, plus admins/superadmins, can download.
router.get("/files/:filename", verifyToken, requireAnyPermission(["store", "supply"]), async (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename); // strip traversal
    const filePath     = path.join(UPLOAD_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File not found on disk." });
    }

    // Look up the original display name from the DB
    const entry = await Supply.findOne({ "attachments.storedName": safeFilename })
      .select("attachments");
    const att         = entry?.attachments?.find((a) => a.storedName === safeFilename);
    const displayName = att?.name ?? safeFilename;

    // Encode to handle spaces / special characters in filenames
    const encoded = encodeURIComponent(displayName);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${displayName}"; filename*=UTF-8''${encoded}`
    );
    res.sendFile(filePath);
  } catch (err) {
    console.error("[supply GET /files/:filename]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── GET /supply/owed -what we currently owe other clients ───────────────────
// Added up from the ledger. Readable with the "supply" OR "store" permission
// (the Store page shows it too). Only groups below zero are returned.
router.get("/owed", verifyToken, requireAnyPermission(["supply", "store"]), async (req, res) => {
  try {
    const rows = await SupplyLedger.aggregate([
      { $sort: { createdAt: 1 } }, // so $last is the most recent description
      {
        $group: {
          _id: { client: "$client", serialNumber: "$serialNumber" },
          total: { $sum: "$qtyChange" },
          goodsSupplied: { $last: "$goodsSupplied" },
          lastTakenAt: { $max: { $cond: [{ $eq: ["$type", "borrowed_out"] }, "$createdAt", null] } },
        },
      },
      { $match: { total: { $lt: 0 } } },
      {
        $project: {
          _id: 0,
          client: "$_id.client",
          serialNumber: "$_id.serialNumber",
          goodsSupplied: 1,
          lastTakenAt: 1,
          owed: { $multiply: ["$total", -1] },
        },
      },
      { $sort: { lastTakenAt: -1 } },
    ]);
    await Client.populate(rows, { path: "client", select: "companyName" });
    // a client that was deleted can no longer be owed anything
    res.json(rows.filter((r) => r.client).map((r) => ({ ...r, client: withId(r.client.toObject?.() ?? r.client) })));
  } catch (err) {
    console.error("[supply GET /owed]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── POST /supply/owed/repay -record that owed stock was replaced ────────────
// Body: { clientId, serialNumber, quantity, note }. Administrators and
// superadmins only. Does NOT change store quantity (the Store page does that).
router.post("/owed/repay", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { clientId, serialNumber, quantity, note } = req.body ?? {};
    const serial = normalizeSerial(serialNumber);
    const qty = Number(quantity);
    const cleanNote = String(note ?? "").trim();

    if (!clientId || !serial) return res.status(400).json({ message: "Client and serial number are required." });
    if (quantity === "" || quantity === null || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ message: "Enter a quantity above 0." });
    }
    if (cleanNote.length > 300) return res.status(400).json({ message: "Note must be 300 characters or less." });

    let client;
    try {
      client = await resolveClientReference(clientId);
    } catch {
      return res.status(400).json({ message: "Client not found." });
    }

    const owed = -(await ledgerTotal(client, serial));
    if (owed <= 0) return res.status(400).json({ message: "Nothing is owed to this client for that serial number." });
    if (qty > owed) return res.status(400).json({ message: `You only owe ${owed}. Enter ${owed} or less.` });

    const latest = await SupplyLedger.findOne({ client, serialNumber: serial }).sort({ createdAt: -1 }).select("goodsSupplied");
    const row = await SupplyLedger.create({
      client,
      serialNumber: serial,
      goodsSupplied: latest?.goodsSupplied ?? "",
      qtyChange: qty,
      type: "settled",
      note: cleanNote,
      createdBy: req.userId,
    });

    // Two people repaying at once could both pass the check above. Check again
    // now that our row is saved: if the total went above zero we overpaid, so
    // take our row back out.
    if ((await ledgerTotal(client, serial)) > 0) {
      await SupplyLedger.deleteOne({ _id: row._id });
      return res.status(400).json({ message: "The owed amount just changed. Refresh and try again." });
    }

    res.status(201).json({ message: "Repayment recorded." });
  } catch (err) {
    console.error("[supply POST /owed/repay]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── store stock helpers ───────────────────────────────────────────────────────
const restoreStock = (id, qty) => StoreItem.findByIdAndUpdate(id, { $inc: { quantity: qty } });

// ── POST /supply -log a new supply entry with optional file attachments ──────
// Requires "supply" permission (or superadmin).
// The part is found in the Store by serialNumber and its quantity is reduced by
// the supplied amount. If takenFromClientId is sent, stock was taken from
// another client: administrators only, and a "we owe them" ledger row is added.
// Uses handleUpload (wraps multer) so any upload error returns JSON, not HTML.
router.post(
  "/",
  verifyToken,
  requirePermission("supply"),
  handleUpload,
  async (req, res) => {
    const dropFiles = () => (req.files || []).forEach((f) => fs.unlink(f.path, () => {}));
    let deducted = false;
    let storeItemId = null;
    let ledgerRow = null;
    let qty = 0;

    try {
      const { goodsSupplied, serialNumber, quantity, supplyDate, clientId, takenFromClientId, transferNote } = req.body;
      qty = Number(quantity);
      const normalizedSerial = String(serialNumber || "").trim();

      if (!String(goodsSupplied || "").trim() || !normalizedSerial || !quantity || !supplyDate || !clientId) {
        dropFiles();
        return res.status(400).json({ message: "All fields are required." });
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        dropFiles();
        return res.status(400).json({ message: "Enter a valid quantity." });
      }
      if (Number.isNaN(new Date(supplyDate).getTime())) {
        dropFiles();
        return res.status(400).json({ message: "Enter a valid supply date." });
      }

      // ── optional: stock taken from another client ───────────────────────────
      const isTransfer = takenFromClientId !== undefined && takenFromClientId !== null && String(takenFromClientId).trim() !== "";
      const note = String(transferNote ?? "").trim();
      if (isTransfer) {
        if (!canRecordTransfers(req)) {
          dropFiles();
          return res.status(403).json({ message: "Only administrators and superadmins can take stock from another client." });
        }
        if (!note) {
          dropFiles();
          return res.status(400).json({ message: "Add a note explaining why stock was taken from another client." });
        }
        if (note.length > 300) {
          dropFiles();
          return res.status(400).json({ message: "The transfer note must be 300 characters or less." });
        }
      }

      const attachments = (req.files || []).map((f) => ({
        name:       f.originalname,
        storedName: f.filename,
        mimetype:   f.mimetype,
        size:       f.size,
      }));

      const clientReference = await resolveClientReference(clientId);

      let takenFromReference = null;
      if (isTransfer) {
        try {
          takenFromReference = await resolveClientReference(takenFromClientId);
        } catch {
          throw new Error("The client the stock was taken from was not found.");
        }
        if (String(takenFromReference) === String(clientReference)) {
          throw new Error('"Taken from" must be a different client.');
        }
      }

      // ── find the part in the store and take the stock out ───────────────────
      const storeItem = await StoreItem.findOne({ serialNumber: exactCI(normalizedSerial) });
      if (!storeItem) {
        throw new Error("No matching part was found in store for this serial number.");
      }

      const updatedItem = await StoreItem.findOneAndUpdate(
        { _id: storeItem._id, quantity: { $gte: qty } },
        { $inc: { quantity: -qty } },
        { new: true }
      );
      if (!updatedItem) {
        throw new Error(`Insufficient stock. Available quantity: ${storeItem.quantity}`);
      }
      deducted = true;
      storeItemId = storeItem._id;

      // ── ledger row first (so the supply can point at it), then the supply ───
      const supplyId = new mongoose.Types.ObjectId();
      if (isTransfer) {
        ledgerRow = await SupplyLedger.create({
          client: takenFromReference,
          serialNumber: normalizeSerial(storeItem.serialNumber),
          goodsSupplied: String(goodsSupplied).trim(),
          qtyChange: -qty,
          type: "borrowed_out",
          relatedSupply: supplyId,
          note,
          createdBy: req.userId,
        });
      }

      const entry = await Supply.create({
        _id: supplyId,
        goodsSupplied,
        serialNumber: normalizedSerial,
        quantity: qty,
        supplyDate,
        client: clientReference,
        storeItem: storeItem._id,
        takenFrom: takenFromReference,
        transferNote: isTransfer ? note : "",
        user: req.userId,
        attachments,
      });

      const populated = await populateSupply(Supply.findById(entry._id)).lean();
      res.status(201).json(serializeSupply(populated));
    } catch (err) {
      // Undo anything already done: ledger row, store deduction, uploaded files
      if (ledgerRow) await SupplyLedger.deleteOne({ _id: ledgerRow._id }).catch(() => {});
      if (deducted) await restoreStock(storeItemId, qty).catch(() => {});
      dropFiles();
      console.error("[supply POST /]", err);
      res.status(400).json({ message: err.message });
    }
  }
);

// ── DELETE /supply/:id -remove a single entry and its files ─────────────────
// Superadmin-only.
router.delete("/:id", verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const entry = await Supply.findByIdAndDelete(req.params.id);
    if (!entry) return res.status(404).json({ message: "Entry not found." });

    (entry.attachments || []).forEach(({ storedName }) => {
      if (!storedName) return;
      fs.unlink(path.join(UPLOAD_DIR, path.basename(storedName)), () => {});
    });

    try {
      await reverseTransfers([entry._id], req.userId);
    } catch (ledgerErr) {
      console.error("[supply DELETE /:id ledger]", ledgerErr);
      return res.status(500).json({ message: "Entry deleted, but the owed ledger could not be updated. Check the server log." });
    }

    res.json({ message: "Entry deleted." });
  } catch (err) {
    console.error("[supply DELETE /:id]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── POST /supply/bulk-delete -remove multiple entries and their files ────────
// Superadmin-only.
router.post("/bulk-delete", verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids must be a non-empty array." });
    }
    if (!ids.every(isObjectIdString)) {
      return res.status(400).json({ message: "ids must be valid entry ids." });
    }

    const entries = await Supply.find({ _id: { $in: ids } }).select("attachments");
    entries.forEach((entry) =>
      (entry.attachments || []).forEach(({ storedName }) => {
        if (!storedName) return;
        fs.unlink(path.join(UPLOAD_DIR, path.basename(storedName)), () => {});
      })
    );

    const result = await Supply.deleteMany({ _id: { $in: ids } });

    try {
      await reverseTransfers(entries.map((e) => e._id), req.userId);
    } catch (ledgerErr) {
      console.error("[supply POST /bulk-delete ledger]", ledgerErr);
      return res.status(500).json({ message: "Entries deleted, but the owed ledger could not be updated. Check the server log." });
    }

    res.json({ message: `${result.deletedCount} entries deleted.` });
  } catch (err) {
    console.error("[supply POST /bulk-delete]", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;