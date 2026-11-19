// Small helpers shared by the store, supply and schedule routes.

// "sn-1001 " and "SN-1001" are the same item. The owed ledger saves serial
// numbers in this form so it always lines up with the store.
export const normalizeSerial = (value) => String(value ?? "").trim().toUpperCase();
// Kept so older imports keep working; same behaviour as normalizeSerial.
export const normalizePart = normalizeSerial;

export const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case-insensitive "exact match" regex, safe to build from user input.
export const exactCI = (value) => new RegExp(`^${escapeRegExp(String(value).trim())}$`, "i");

// Strict 24-character hex check. mongoose.isValidObjectId is looser than this
// (it accepts any 12-character string), which can let odd input through.
export const isObjectIdString = (value) =>
  typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);

// Adds a plain `id` next to `_id` on a populated reference, because the
// frontend reads `client.id ?? client._id` and `takenFrom.id`.
export const withId = (ref) =>
  ref && typeof ref === "object" && ref._id ? { ...ref, id: ref._id } : ref ?? null;
