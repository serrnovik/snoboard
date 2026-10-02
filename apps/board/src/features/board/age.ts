const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Short age of a timestamp: "now", "5m", "3h", "4d", "2mo", "1y". Null when unparsable. */
export function formatAge(iso: string, now: number = Date.now()): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / MONTH)}mo`;
  return `${Math.floor(elapsed / YEAR)}y`;
}
