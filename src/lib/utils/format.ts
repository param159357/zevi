/**
 * Display helpers. Pure, no I/O.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** `524288000` → `500 MB`. Binary units, because upload caps are quoted that way. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));

  return `${rounded} ${BYTE_UNITS[unit]}`;
}

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

const DATE_SHORT = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "Asia/Kolkata",
});

const TIME = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

/** Everyone on the platform is in India, so every date is rendered there. */
export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

/** `Thu, 20 Aug` — for a deadline, where the weekday is the useful part. */
export function formatDateShort(iso: string): string {
  return DATE_SHORT.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** How long until a deadline, in whole days. Negative once it has passed. */
export function daysUntil(iso: string, from: Date = new Date()): number {
  return Math.ceil((new Date(iso).getTime() - from.getTime()) / 86_400_000);
}
