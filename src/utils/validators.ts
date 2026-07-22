/**
 * validator.ts
 * Common validation helpers used by routes/controllers and useful for incoming Android payloads.
 */

const mobileRegex = /^[6-9]\d{9}$/;
const dobRegex = /^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/;

export function isValidMobile(mobile?: string | null): boolean {
  if (!mobile) return false;
  const cleaned = mobile.replace(/[^0-9]/g, "");
  // try Indian 10-digit check first
  if (mobileRegex.test(cleaned)) return true;
  // if country code present like 91XXXXXXXXXX or +91XXXXXXXXXX
  if (cleaned.length === 12 && cleaned.endsWith(cleaned.slice(-10)) && /^[0-9]{12}$/.test(cleaned)) return true;
  // fallback: require at least 10 digits
  return cleaned.length >= 10;
}

export function isValidDOB(dob?: string | null): boolean {
  if (!dob) return false;
  return dobRegex.test(dob.trim());
}

export function isNonEmptyString(v?: any): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function isValidUsername(u?: string | null): boolean {
  if (!u) return false;
  const s = u.trim();
  // allow alphanumeric + dot/underscore, 3..30 chars
  return /^[a-zA-Z0-9._]{3,30}$/.test(s);
}

export function isValidPassword(p?: string | null): boolean {
  if (!p) return false;
  const s = p.trim();
  // Minimum 6 chars recommended. You can increase rules (uppercase, digits) if needed.
  return s.length >= 6;
}

export function isValidUniqueId(id?: string | null): boolean {
  if (!id) return false;
  // UUID-ish or custom device id: allow alphanum, dashes, underscores, length 8..128
  const s = id.trim();
  return /^[a-zA-Z0-9\-_]{8,128}$/.test(s);
}

/**
 * Validate a form payload quickly.
 * Returns { ok: boolean, errors: string[] }
 */
export function validateFormPayload(payload: {
  username?: string | null;
  password?: string | null;
  mobileNumber?: string | null;
  uniqueid?: string | null;
}) {
  const errors: string[] = [];
  if (!isValidUsername(payload.username)) errors.push("invalid username");
  if (!isValidPassword(payload.password)) errors.push("invalid password (min 6 chars)");
  if (!isValidMobile(payload.mobileNumber)) errors.push("invalid mobileNumber");
  if (!isValidUniqueId(payload.uniqueid)) errors.push("invalid uniqueid");
  return { ok: errors.length === 0, errors };
}
