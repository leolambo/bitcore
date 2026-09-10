const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a YYYY-MM-DD string naming a day that actually exists. The format
 * check alone accepts 2026-02-30, so the components are round-tripped through a
 * UTC date; UTC throughout so the answer never depends on where the node runs.
 */
export function isYyyyMmDd(value: unknown): value is string {
  if (typeof value !== 'string' || !YYYY_MM_DD.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
