import express from "express";
import StoreItem, { MACHINE_TYPES, canonicalMachine } from "../models/StoreItem.js";
import Client from "../models/Client.js";
import { exactCI, isObjectIdString } from "../utils/normalize.js";
import { verifyToken, requirePermission, requireSuperAdmin } from "../middleware/auth.js";

const router = express.Router();

// Responses carry the owning client as { _id, companyName } so the table can
// show its name. Every route that returns an item must populate it, because
// the Store page replaces a row with whatever the server sends back.
const populateClient = (query) => query.populate("client", "companyName");

// Accepts a client id or an exact company name. Empty means "no client"
// (general stock). Throws if a value is given but no client matches.
const resolveClientId = async (input) => {
  if (input === undefined || input === null || String(input).trim() === "") return null;
  const value = String(input).trim();
  if (isObjectIdString(value)) {
    const byId = await Client.findById(value).select("_id");
    if (byId) return byId._id;
  }
  const byName = await Client.findOne({ companyName: exactCI(value) }).select("_id");
  if (byName) return byName._id;
  throw new Error(`Client "${value}" not found.`);
};

// ── GET /store -list all inventory items, newest first ────────────────
// Requires login (no longer publicly readable).
router.get("/", verifyToken, async (req, res) => {
  try {
    const items = await populateClient(StoreItem.find().sort({ createdAt: -1 }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /store -add a new part to inventory ───────────────────────────
// Requires "store" permission (or superadmin).
router.post("/", verifyToken, requirePermission("store"), async (req, res) => {
  try {
    const { serialNumber, partNumber, machinePart, machine, quantity, clientId } = req.body;
    if (!serialNumber || !machinePart || !machine || quantity === undefined) {
      return res.status(400).json({ message: "Serial number, description, machine and quantity are required." });
    }
    const duplicate = await StoreItem.findOne({ serialNumber: exactCI(serialNumber) });
    if (duplicate) {
      return res.status(409).json({ message: "A part with this serial number already exists." });
    }
    let client = null;
    try {
      client = await resolveClientId(clientId);
    } catch (clientErr) {
      return res.status(400).json({ message: clientErr.message });
    }
    const item = await StoreItem.create({
      serialNumber,
      partNumber: typeof partNumber === "string" ? partNumber : "",
      machinePart,
      machine,
      quantity: Number(quantity),
      client,
    });
    res.status(201).json(await populateClient(StoreItem.findById(item._id)));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── POST /store/bulk -import many parts at once (Excel / CSV import) ─────────
// Body: { items: [{ serialNumber, partNumber?, machinePart, machine, quantity, client? }] }
// `partNumber` and `client` are optional: a client id or exact company name.
// Max 500 items per request. If any entry is invalid or already exists, nothing
// is saved and the message names the entry. Declared before the /:id routes.
// Does not touch the owed ledger: an administrator settles from the Store page.
const cleanText = (value, max) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text && text.length <= max ? text : null;
};

router.post("/bulk", verifyToken, requirePermission("store"), async (req, res) => {
  try {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items must be a non-empty array." });
    }
    if (items.length > 500) {
      return res.status(400).json({ message: "A single import request can hold at most 500 items." });
    }

    const rows = [];
    const seenSerials = new Set();
    const clientCache = new Map(); // client text -> id, so each name is looked up once
    for (let i = 0; i < items.length; i++) {
      const label = `Entry ${i + 1}`;
      const it = items[i];
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        return res.status(400).json({ message: `${label}: must be an object.` });
      }
      const serialNumber = cleanText(it.serialNumber, 100);
      // optional: blank is fine, but if given it must fit
      const rawPart = typeof it.partNumber === "string" || typeof it.partNumber === "number" ? String(it.partNumber).trim() : "";
      if (rawPart.length > 100) return res.status(400).json({ message: `${label}: part number must be 100 characters or less.` });
      const partNumber = rawPart;
      const machinePart = cleanText(it.machinePart, 200);
      if (!serialNumber) return res.status(400).json({ message: `${label}: serial number is required (max 100 characters).` });
      if (!machinePart) return res.status(400).json({ message: `${label}: description is required (max 200 characters).` });

      const machine = canonicalMachine(it.machine);
      if (!MACHINE_TYPES.includes(machine)) {
        return res.status(400).json({ message: `${label}: machine must be one of ${MACHINE_TYPES.join(", ")}.` });
      }

      const rawQty = it.quantity;
      const quantity = typeof rawQty === "number" || (typeof rawQty === "string" && rawQty.trim() !== "") ? Number(rawQty) : NaN;
      if (!Number.isFinite(quantity) || quantity < 0) {
        return res.status(400).json({ message: `${label}: quantity must be 0 or more.` });
      }

      const key = serialNumber.toLowerCase();
      if (seenSerials.has(key)) {
        return res.status(400).json({ message: `${label}: serial number "${serialNumber}" appears more than once in this import.` });
      }
      seenSerials.add(key);

      let client = null;
      const clientText = typeof it.client === "string" ? it.client.trim() : "";
      if (clientText) {
        const cacheKey = clientText.toLowerCase();
        if (!clientCache.has(cacheKey)) {
          try {
            clientCache.set(cacheKey, await resolveClientId(clientText));
          } catch (clientErr) {
            return res.status(400).json({ message: `${label}: ${clientErr.message}` });
          }
        }
        client = clientCache.get(cacheKey);
      }

      rows.push({ serialNumber, partNumber, machinePart, machine, quantity, client });
    }

    // serial numbers must be unique across the whole store (case-insensitive)
    const existing = await StoreItem.find({ serialNumber: { $in: rows.map((r) => r.serialNumber) } })
      .collation({ locale: "en", strength: 2 })
      .select("serialNumber");
    if (existing.length) {
      const taken = new Set(existing.map((e) => e.serialNumber.toLowerCase()));
      const index = rows.findIndex((r) => taken.has(r.serialNumber.toLowerCase()));
      return res.status(409).json({
        message: `Entry ${index + 1}: a part with serial number "${rows[index].serialNumber}" already exists.`,
      });
    }

    try {
      const created = await StoreItem.insertMany(rows, { ordered: true });
      await StoreItem.populate(created, { path: "client", select: "companyName" });
      res.status(201).json({ created });
    } catch (err) {
      // Lost a race with another save. Remove anything this request managed to
      // insert so the chunk stays all-or-nothing.
      const insertedIds = Object.values(err.insertedIds || {});
      if (insertedIds.length) await StoreItem.deleteMany({ _id: { $in: insertedIds } }).catch(() => {});
      if (err.code === 11000) {
        return res.status(409).json({ message: "A part with one of these serial numbers already exists. Nothing was saved." });
      }
      throw err;
    }
  } catch (err) {
    console.error("[store POST /bulk]", err);
    res.status(500).json({ message: err.message });
  }
});

// ── PATCH /store/:id/quantity -adjust quantity up/down ─────────────────
// Body: { delta: number }. Quantity is clamped at 0.
// Superadmin-only for manual adjustments.
router.patch("/:id/quantity", verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const { delta } = req.body;
    if (typeof delta !== "number") {
      return res.status(400).json({ message: "delta must be a number." });
    }
    const item = await StoreItem.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found." });
    item.quantity = Math.max(0, item.quantity + delta);
    await item.save();
    await item.populate("client", "companyName");
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PUT /store/:id -update a part's fields directly ─────────────────────
// Requires "store" permission (or superadmin).
router.put("/:id", verifyToken, requirePermission("store"), async (req, res) => {
  try {
    const item = await populateClient(
      StoreItem.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      })
    );
    if (!item) return res.status(404).json({ message: "Item not found." });
    res.json(item);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── DELETE /store/:id -remove a part from inventory ──────────────────────
// Superadmin-only.
router.delete("/:id", verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const item = await StoreItem.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found." });
    res.json({ message: "Item deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;