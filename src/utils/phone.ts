/**
 * phone utilities
 *
 * - sanitizePhone: cleans a raw phone string and ensures it has at least 10 digits.
 * - normalizeToE164IfPossible: attempts to return +<country><number> if raw already includes country.
 *
 * Note: We keep this simple and deterministic — don't try to be too clever across countries.
 */

export function sanitizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const s = raw.toString().trim();
  if (!s) return null;

  // Remove common separators but keep leading +
  const cleaned = (s.startsWith("+") ? "+" : "") + s.replace(/[^0-9]/g, "");
  // remove leading plus handling: digitsOnly
  const digitsOnly = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;

  // basic rule: require at least 10 digits (common for India); if more, allow (country code present)
  if (digitsOnly.length < 10) return null;

  // If original had +, return +digits, else return digits (no formatting)
  return cleaned.startsWith("+") ? `+${digitsOnly}` : digitsOnly;
}

/**
 * Try to format to E.164 if number already has country code (heuristic).
 * If not possible, returns original sanitized number.
 */
export function normalizeToE164IfPossible(raw?: string | null, defaultCountryCode = "91"): string | null {
  const s = sanitizePhone(raw);
  if (!s) return null;

  if (s.startsWith("+")) return s;
  // if length is already > 10, maybe includes country code without +
  if (s.length > 10) return `+${s}`;
  // otherwise treat as local and prefix with defaultCountryCode
  return `+${defaultCountryCode}${s}`;
}
