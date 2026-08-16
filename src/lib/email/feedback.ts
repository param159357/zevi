/**
 * What SES says happened after it accepted a message — spec §15's other half.
 *
 * `ses.ts` covers the synchronous answer: Amazon took the message, or refused
 * it. This file covers the asynchronous one, which is where a bounce lives. SES
 * returns a `MessageId` and 200; the recipient's server rejects the mail seconds
 * to hours later; SES publishes that to an SNS topic; the endpoint in
 * `app/api/webhooks/ses` verifies the envelope and hands the payload here.
 *
 * Two halves, and only the first is testable without a database:
 *
 *   * `parseSesFeedback` — pure. A notification in, zero or more typed
 *     per-recipient events out.
 *   * `recordEmailFeedback` — the write, through the one function that applies
 *     an event to the log, the outbox row and the suppression list in a single
 *     transaction.
 *
 * ### Two payload shapes, and why both are handled
 *
 * SES publishes feedback two ways and this platform can be configured either
 * way, so the parser reads both rather than depending on which was set up:
 *
 *   * **identity notifications** — the topic is attached to the verified domain,
 *     and the payload's discriminator is `notificationType`.
 *   * **configuration set event destinations** — the topic is attached to the
 *     configuration set named by `SES_CONFIGURATION_SET`, and the discriminator
 *     is `eventType`. This is the modern path, the one `scripts/ses-domain.ts
 *     notifications` sets up, and the one that can also publish opens, clicks
 *     and sends.
 *
 * The bodies underneath are the same. The discriminator is not, and reading only
 * one of them is the sort of bug that looks like "bounces are not arriving"
 * rather than like a parser.
 *
 * ### Why an unrecognised event is not an error
 *
 * A configuration set can be edited in a console, and the events it publishes
 * are a checklist somebody ticks. An `Open` arriving here means a box got ticked
 * that spec §15 would rather was not — it does not mean the message was
 * malformed, and answering anything but "fine, ignored" would make SNS retry it
 * for days.
 */

import type { Database, Json } from "@/types/database.types";
import { createServiceRoleClient } from "@/lib/supabase/server";

type EmailEventType = Database["public"]["Enums"]["email_event_type"];

export type EmailFeedbackEvent = {
  type: EmailEventType;
  /** SES's `mail.messageId` — what `mark_email_sent()` wrote to the outbox row. */
  providerMessageId: string;
  recipient: string;
  /**
   * The second axis of the event: `Permanent` / `Transient` / `Undetermined`
   * for a bounce, the feedback type for a complaint, the delay type for a
   * delay. Null when the event has none.
   *
   * The bounce values are load-bearing — `record_email_feedback()` suppresses
   * an address on `Permanent` and counts the rest — so they are passed through
   * exactly as SES spells them rather than being lowercased on the way.
   */
  subtype: string | null;
  diagnostic: string | null;
  /** ISO 8601, as SES reports it. When it happened, not when we heard. */
  occurredAt: string;
};

/** SES's words for the events we act on, in both payload shapes. */
const EVENT_TYPES: Record<string, EmailEventType> = {
  Bounce: "bounce",
  Complaint: "complaint",
  Delivery: "delivery",
  DeliveryDelay: "delivery_delay",
  Reject: "reject",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** SES gives a timestamp on the event and another on the mail. Either will do. */
function asTimestamp(value: unknown, fallback: string): string {
  const raw = asString(value);
  if (raw === null) return fallback;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/**
 * The addresses named by one recipient list.
 *
 * SES spells a recipient list two ways: objects with an `emailAddress` on a
 * bounce, a complaint or a delay, and bare strings in `mail.destination`, which
 * is what a `Reject` has to fall back to. Both are read here so the callers
 * below stay a table rather than a set of special cases.
 */
function recipientsOf(value: unknown): Array<{ address: string; diagnostic: string | null }> {
  if (!Array.isArray(value)) return [];

  const recipients: Array<{ address: string; diagnostic: string | null }> = [];

  for (const entry of value) {
    const bare = asString(entry);
    if (bare) {
      recipients.push({ address: bare, diagnostic: null });
      continue;
    }

    const record = asRecord(entry);
    if (!record) continue;

    const address = asString(record.emailAddress);
    if (!address) continue;

    // `diagnosticCode` is the receiving server's own words — "550 5.1.1 user
    // unknown" — and `status` is the enhanced status code on its own. The first
    // is what a support conversation needs; the second is what is there when the
    // remote server was tersest.
    recipients.push({
      address,
      diagnostic: asString(record.diagnosticCode) ?? asString(record.status),
    });
  }

  return recipients;
}

/**
 * Turn one SES notification into zero or more per-recipient events.
 *
 * Zero is an ordinary answer: an event type we do not act on, or a payload with
 * no recipients we can name. One notification can carry several — a message to
 * three addresses that all bounced is one SNS delivery and three rows — which is
 * why `email_events` is unique on the envelope id *and* the recipient rather
 * than on the envelope id alone.
 */
export function parseSesFeedback(message: unknown): EmailFeedbackEvent[] {
  const body = asRecord(message);
  if (!body) return [];

  // The two shapes, read in the order that puts the more specific first: an
  // identity notification has only `notificationType`, a configuration set event
  // has only `eventType`.
  const word = asString(body.notificationType) ?? asString(body.eventType);
  if (!word) return [];

  const type = EVENT_TYPES[word];
  if (!type) return [];

  const mail = asRecord(body.mail);
  const providerMessageId = asString(mail?.messageId);

  if (!providerMessageId) {
    // Without the message id there is nothing to attach the event to, and the
    // address alone would suppress on the word of a payload we cannot tie to
    // anything we sent.
    return [];
  }

  const mailTimestamp = asTimestamp(mail?.timestamp, new Date().toISOString());

  const detail = asRecord(
    type === "bounce"
      ? body.bounce
      : type === "complaint"
        ? body.complaint
        : type === "delivery"
          ? body.delivery
          : type === "delivery_delay"
            ? body.deliveryDelay
            : body.reject,
  );

  const occurredAt = asTimestamp(detail?.timestamp, mailTimestamp);

  switch (type) {
    case "bounce": {
      // `bounceType` is the value the whole suppression rule turns on;
      // `bounceSubType` refines it ("General", "NoEmail", "Suppressed") and is
      // worth keeping, so it rides along in the diagnostic rather than
      // displacing the value that decides.
      const bounceType = asString(detail?.bounceType) ?? "Undetermined";
      const bounceSubType = asString(detail?.bounceSubType);

      return recipientsOf(detail?.bouncedRecipients).map((recipient) => ({
        type,
        providerMessageId,
        recipient: recipient.address,
        subtype: bounceType,
        diagnostic: [bounceSubType, recipient.diagnostic].filter(Boolean).join(": ") || null,
        occurredAt,
      }));
    }

    case "complaint": {
      // `complaintFeedbackType` is the ARF class — abuse, fraud, not-spam — and
      // is absent more often than not, because most providers report a complaint
      // without saying what kind.
      const feedbackType =
        asString(detail?.complaintFeedbackType) ?? asString(detail?.complaintSubType);

      return recipientsOf(detail?.complainedRecipients).map((recipient) => ({
        type,
        providerMessageId,
        recipient: recipient.address,
        subtype: feedbackType,
        diagnostic: asString(detail?.userAgent),
        occurredAt,
      }));
    }

    case "delivery": {
      const smtpResponse = asString(detail?.smtpResponse);

      return recipientsOf(detail?.recipients).map((recipient) => ({
        type,
        providerMessageId,
        recipient: recipient.address,
        subtype: null,
        diagnostic: smtpResponse,
        occurredAt,
      }));
    }

    case "delivery_delay": {
      const delayType = asString(detail?.delayType);

      return recipientsOf(detail?.delayedRecipients).map((recipient) => ({
        type,
        providerMessageId,
        recipient: recipient.address,
        subtype: delayType,
        diagnostic: recipient.diagnostic,
        occurredAt,
      }));
    }

    case "reject": {
      // A reject names no recipients of its own — SES refused the message
      // before anybody's server saw it — so the addresses come from the mail
      // envelope. Nothing is suppressed on one of these; it is our problem.
      const reason = asString(detail?.reason);

      return recipientsOf(mail?.destination).map((recipient) => ({
        type,
        providerMessageId,
        recipient: recipient.address,
        subtype: null,
        diagnostic: reason,
        occurredAt,
      }));
    }
  }
}

export type FeedbackSummary = {
  recorded: number;
  duplicate: number;
  suppressed: number;
  failed: number;
};

/**
 * Apply the events from one SNS message.
 *
 * Each one goes through `record_email_feedback()`, which does the log row, the
 * outbox row's status and the suppression in a single transaction — so a partial
 * application is not representable, and the webhook has nothing to unwind if the
 * second of three events fails.
 *
 * Sequential, and not for the rate-limit reason the two drains are: these writes
 * contend on the same suppression row whenever a notification names one address
 * twice, and the soft-bounce count is read inside the same transaction that
 * inserts the event it counts. Running them in parallel would make the third
 * soft bounce sometimes the second.
 */
export async function recordEmailFeedback(
  snsMessageId: string,
  events: readonly EmailFeedbackEvent[],
  /**
   * The notification as SES sent it, stored verbatim on every row this produces.
   *
   * Duplicated across the recipients of one message on purpose. `email_events`
   * is the evidence behind a suppression, and the columns above are only the
   * fields we thought to parse — the day SES reports something in a shape this
   * parser flattens or drops, the answer has to still be in the row rather than
   * in a log that has rotated.
   */
  message: unknown,
): Promise<FeedbackSummary> {
  const admin = createServiceRoleClient();
  const summary: FeedbackSummary = { recorded: 0, duplicate: 0, suppressed: 0, failed: 0 };

  for (const event of events) {
    const { data, error } = await admin.rpc("record_email_feedback", {
      p_sns_message_id: snsMessageId,
      p_provider_message_id: event.providerMessageId,
      p_event_type: event.type,
      p_recipient: event.recipient,
      ...(event.subtype ? { p_subtype: event.subtype } : {}),
      ...(event.diagnostic ? { p_diagnostic: event.diagnostic } : {}),
      p_occurred_at: event.occurredAt,
      p_payload: (message ?? {}) as Json,
    });

    if (error) {
      // Counted rather than thrown, so one bad event does not lose the others in
      // the same notification. The route turns a non-zero `failed` into a 500,
      // which asks SNS to redeliver the whole message — the events that did land
      // are idempotent on the envelope id, so a redelivery costs nothing.
      summary.failed += 1;
      console.error(
        `[ses-feedback] could not record ${event.type} for ${event.recipient}: ${error.message}`,
      );
      continue;
    }

    const result = data?.[0];

    if (result?.outcome === "duplicate") {
      summary.duplicate += 1;
      continue;
    }

    if (result?.outcome !== "recorded") {
      summary.failed += 1;
      console.error(
        `[ses-feedback] ${event.type} for ${event.recipient} was refused: ${result?.outcome ?? "no result"}`,
      );
      continue;
    }

    summary.recorded += 1;

    if (result.suppressed) {
      summary.suppressed += 1;
      // Loud on purpose. An address going on the list means a real person stops
      // hearing from the platform, and spec §15's failure mode is exactly that
      // happening without anybody knowing.
      console.warn(
        `[ses-feedback] suppressed ${event.recipient} after a ${event.type} (${event.subtype ?? "no subtype"})`,
      );
    }
  }

  return summary;
}
