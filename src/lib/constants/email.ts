/**
 * Email constants — spec §15.
 *
 * Two kinds of number live here. The delivery ones (batch size, attempts,
 * backoff) are this codebase's own decisions about a queue, with no database
 * rule behind them. The palette is a copy of the four tokens from
 * `globals.css` that an email can actually use: a mail client strips `<style>`
 * as often as it honours it, so every colour below is inlined on the element.
 */

/**
 * How many queued emails one drain sends.
 *
 * Each one is a signed HTTPS round trip to Amazon, sent sequentially so a
 * backlog cannot open fifty sockets at once, and the whole drain has to finish
 * inside a serverless request. Twenty-five at roughly 300ms each is a few
 * seconds; a backlog larger than that is drained by the next run ten minutes
 * later, which is the right speed for mail nobody is watching a spinner for.
 */
export const EMAIL_BATCH_SIZE = 25;

/**
 * How many times one email is attempted before it is left `failed` for a human.
 *
 * Mirrors `platform_settings.email.max_attempts`, which is what actually
 * decides: `mark_email_failed()` reads it and marks a row failed past the
 * ceiling however politely the drain asks for a retry. Same relationship every
 * other constant here has with its database rule — a stale copy makes a
 * sentence wrong, never a limit loose.
 *
 * SES answers a hard bounce synchronously in some cases and asynchronously in
 * others, so retrying is only ever worth it for the transient class — a
 * throttle or a 5xx. Five attempts over the backoff below spans about ninety
 * minutes, and rather more in practice because the drain only runs every ten:
 * enough for a sending-rate ceiling to lift or a region to come back, and well
 * short of hammering an address that will never accept mail.
 */
export const EMAIL_MAX_ATTEMPTS = 5;

/**
 * Backoff before the next attempt, in seconds, indexed by attempts already
 * made. Quadrupling from a minute: 1m, 4m, 16m, 64m.
 */
export function emailRetryDelaySeconds(attempts: number): number {
  return 60 * 4 ** Math.max(attempts - 1, 0);
}

/**
 * A stale `sending` row is one whose drain died between claiming it and
 * recording the outcome. After this it is claimable again. Longer than any
 * plausible request, short enough that a crashed run does not strand a
 * client's receipt for a day.
 */
export const EMAIL_CLAIM_STALE_MINUTES = 15;

/**
 * Spec §5's nudges — "12h/30h and 24h/60h" — expressed as the fractions of the
 * auto-accept window they are. The 36-hour window gives 12h and 30h; the
 * three-day window gives 24h and 60h. Both are a third and five sixths elapsed,
 * which is the rule those four numbers are two instances of.
 */
export const AUTO_ACCEPT_REMINDER_FRACTIONS = [1 / 3, 5 / 6] as const;

/**
 * How many deliveries one sweep will remind. Matches `AUTO_ACCEPT_SWEEP_LIMIT`
 * — the same rows, one hour earlier in their life.
 */
export const AUTO_ACCEPT_REMINDER_LIMIT = 100;

/**
 * The four colours an email uses, inlined. Light-mode values only: a mail
 * client that inverts for dark mode does it to the rendered HTML, and one that
 * does not would show a dark-mode palette on white.
 */
export const EMAIL_COLORS = {
  background: "#f6f6f7",
  surface: "#ffffff",
  border: "#e4e4e7",
  foreground: "#171717",
  muted: "#5b6472",
  primary: "#18181b",
  primaryForeground: "#fafafa",
} as const;

/** Where a recipient writes back. Rendered in the footer of every email. */
export const SUPPORT_EMAIL = "support@zevi.in";

/** Body width. 600px is the width every mail client lays out comfortably. */
export const EMAIL_WIDTH_PX = 600;
