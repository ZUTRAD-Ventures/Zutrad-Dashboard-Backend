// One-off migration: the owed ledger used to be keyed by (client, partNumber).
// It is now keyed by (client, serialNumber). Run once after deploying:
//
//   node scripts/migrate-ledger-to-serial.js
//
// How old rows are converted:
//   1. rows linked to a supply entry (borrowed_out / reversed) take that
//      entry's serialNumber.
//   2. "settled" rows (and rows whose supply entry was since deleted) take the
//      serial number of the same client's converted rows for the same part, but only when
//      that part had exactly ONE serial number. If it had several, the row is
//      listed at the end for you to fix by hand.
// Old partNumber fields on ledger and supply rows are removed afterwards.
// Safe to run more than once.
import connectDB from "../config/db.js";
import mongoose from "mongoose";

const up = (v) => String(v ?? "").trim().toUpperCase();

const main = async () => {
  try {
    await connectDB();
    const ledger = mongoose.connection.collection("supplyledgers");
    const supplies = mongoose.connection.collection("supplies");

    const pending = await ledger.find({ serialNumber: { $exists: false } }).toArray();
    console.log(`Ledger rows without a serial number: ${pending.length}`);

    // pass 1: rows linked to a supply entry
    const keyToSerials = new Map(); // "clientId|PART" -> Set of serials
    const unresolved = [];
    const done = new Set();
    let linked = 0;
    for (const row of pending) {
      if (!row.relatedSupply) continue;
      const s = await supplies.findOne({ _id: row.relatedSupply }, { projection: { serialNumber: 1 } });
      if (!s?.serialNumber) continue; // supply was deleted; pass 2 will try to infer it
      done.add(String(row._id));
      const serial = up(s.serialNumber);
      await ledger.updateOne({ _id: row._id }, { $set: { serialNumber: serial } });
      const key = `${row.client}|${up(row.partNumber)}`;
      if (!keyToSerials.has(key)) keyToSerials.set(key, new Set());
      keyToSerials.get(key).add(serial);
      linked++;
    }
    console.log(`Converted from linked supply entries: ${linked}`);

    // pass 2: unlinked rows (settled)
    let inferred = 0;
    for (const row of pending) {
      if (done.has(String(row._id))) continue;
      const key = `${row.client}|${up(row.partNumber)}`;
      const set = keyToSerials.get(key);
      if (set && set.size === 1) {
        await ledger.updateOne({ _id: row._id }, { $set: { serialNumber: [...set][0] } });
        inferred++;
      } else {
        unresolved.push(row);
      }
    }
    console.log(`Converted by inference (settled / deleted-supply rows): ${inferred}`);

    if (unresolved.length) {
      console.log(`\n${unresolved.length} row(s) could not be converted. Set serialNumber on them by hand:`);
      unresolved.forEach((r) => console.log(`  _id ${r._id}  client ${r.client}  part ${r.partNumber}  type ${r.type}  qty ${r.qtyChange}`));
    }

    // clean up only if everything has a serial number
    const stillMissing = await ledger.countDocuments({ serialNumber: { $exists: false } });
    if (stillMissing === 0) {
      await ledger.updateMany({ partNumber: { $exists: true } }, { $unset: { partNumber: "" } });
      await supplies.updateMany({ partNumber: { $exists: true } }, { $unset: { partNumber: "" } });
      try { await ledger.dropIndex("client_1_partNumber_1"); } catch { /* index already gone */ }
      await ledger.createIndex({ client: 1, serialNumber: 1 });
      console.log("\nDone. Old partNumber fields and index removed.");
    } else {
      console.log(`\n${stillMissing} row(s) still lack a serial number, so partNumber fields were left in place. Fix them and run this script again.`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    try { await mongoose.disconnect(); } catch (e) {}
  }
};

main();
