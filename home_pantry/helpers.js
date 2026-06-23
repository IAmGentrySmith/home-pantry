/**
 * Shared, dependency-free pure helpers.
 *
 * These are imported by the server AND exercised directly by the unit tests,
 * so the tests cover the real implementation rather than copies of it.
 */

/** Format a Date as a LOCAL (not UTC) YYYY-MM-DD string. */
export function toLocalISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today's date as a LOCAL YYYY-MM-DD string. */
export function todayISO() {
  return toLocalISODate(new Date());
}

/**
 * Compute a LOCAL YYYY-MM-DD string `days` days from today.
 * Returns null when days is falsy or <= 0 (e.g. non-perishable items).
 * Uses local time so it agrees with the dates the browser UI compares against.
 */
export function computeExpirationDate(days) {
  if (!days || days <= 0) return null;
  const exp = new Date();
  exp.setDate(exp.getDate() + days);
  return toLocalISODate(exp);
}

/** Escape LIKE wildcard characters in user input to prevent LIKE injection. */
export function escapeLike(str) {
  return str.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Basic UPC format validation.
 * Accepts UPC-A (12 digits), EAN-13 (13), EAN-8 (8), other 8-14 digit codes,
 * and internal/generic UPCs starting with 'generic_'.
 */
export function isValidUPC(upc) {
  if (!upc || typeof upc !== 'string') return false;
  if (upc.startsWith('generic_')) return true;
  return /^\d{8,14}$/.test(upc.trim());
}

/**
 * Parse an LLM shelf-life reply into a day count.
 * Preserves a genuine 0 (the prompt asks the model to return 0 for
 * non-perishable items) and only falls back to 14 when the reply contains no
 * parseable integer. This is the fix for "0 was silently coerced to 14".
 */
export function parseShelfLifeDays(text) {
  const digits = String(text).replace(/[^0-9]/g, '');
  if (digits === '') return 14;
  const n = parseInt(digits, 10);
  return Number.isNaN(n) ? 14 : n;
}

/**
 * Validate that a string is a real calendar date in YYYY-MM-DD form.
 * Rejects bad formats (2026-99-99) and silent overflows (2026-02-30).
 */
export function isValidCalendarDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
