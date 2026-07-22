/**
 * helpers.ts
 * Small general-purpose helpers used across the backend.
 */

export function safeJsonParse<T = any>(text: string | null | undefined, fallback: T | null = null): T | null {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function nowMs(): number {
  return Date.now();
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Simple sleep/delay for async flows (ms) */
export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format timestamp (ms) to yyyy-mm-dd hh:MM:ss */
export function formatTimestamp(ts?: number | Date): string {
  const d = typeof ts === "number" ? new Date(ts) : (ts instanceof Date ? ts : new Date());
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Ensure value is an array */
export function ensureArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Pick subset of object keys (shallow) */
export function pick(obj: Record<string, any> | null | undefined, keys: string[]) {
  if (!obj) return {};
  const out: Record<string, any> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}
