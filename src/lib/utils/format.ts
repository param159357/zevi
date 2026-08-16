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

/**
 * How a job is named to a person: the first eight characters of its id.
 *
 * Spec §15 wants the job ID in every subject line, and a full UUID in a subject
 * line is 36 characters of noise that pushes the sentence off a phone screen.
 * Eight hex characters are unambiguous across any number of jobs this platform
 * will ever have, they are what the delivery watermark already stamps
 * (`lib/deliveries/preview.ts`), and — the point — they are a prefix, so a
 * client quoting one to support can be looked up with a `like`.
 *
 * Lower case, matching the watermark and the id itself. A reference a user
 * retypes in a different case is the same reference; nothing compares these.
 */
export function jobReference(jobId: string): string {
  return jobId.slice(0, 8);
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

/**
 * `Thu, 20 Aug at 6:30 pm` — a moment, named in full.
 *
 * For email, where there is no page around the date to say which month it is
 * and no tooltip to hover. Everything is IST, like every other date here.
 */
export function formatWhen(iso: string): string {
  return `${DATE_SHORT.format(new Date(iso))} at ${TIME.format(new Date(iso))}`;
}

/** How long until a deadline, in whole days. Negative once it has passed. */
export function daysUntil(iso: string, from: Date = new Date()): number {
  return Math.ceil((new Date(iso).getTime() - from.getTime()) / 86_400_000);
}

/**
 * `4.8 ★` — or null when there is nothing to average yet, which the caller says
 * in words instead. Spec §6 never shows a rating without its job count beside
 * it, so the count is the caller's to render and this only formats the number.
 */
export function formatRating(rating: number | null): string | null {
  return rating === null ? null : `${rating.toFixed(1)} ★`;
}

/** `12 jobs` · `1 job`. */
export function formatCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/**
 * `2 days left` · `14 hours left` · `9 minutes left`. For the auto-accept clock,
 * whose longer window is three days — where `72h left` is arithmetically right
 * and reads like a mistake.
 */
export function formatRemaining(iso: string, from: Date = new Date()): string {
  const minutes = Math.round((new Date(iso).getTime() - from.getTime()) / 60_000);

  if (minutes <= 0) return "any moment now";
  if (minutes < 60) return `${formatCount(minutes, "minute")} left`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${formatCount(hours, "hour")} left`;

  return `${formatCount(Math.round(hours / 24), "day")} left`;
}

/**
 * `4h left` · `20m left` · `3h overdue`. For SLA clocks, where a day is too
 * coarse to be worth rendering — the worker approval queue runs on 24 hours.
 */
export function formatCountdown(iso: string, from: Date = new Date()): string {
  const minutes = Math.round((new Date(iso).getTime() - from.getTime()) / 60_000);
  const size = Math.abs(minutes);
  const amount = size >= 60 ? `${Math.floor(size / 60)}h` : `${size}m`;

  return minutes < 0 ? `${amount} overdue` : `${amount} left`;
}
