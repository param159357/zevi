/**
 * What a template is, and how its payload survives a deploy.
 *
 * An email is queued now and sent minutes later, sometimes hours later if SES
 * is throttling — and in between, the code that renders it can be replaced.
 * So the payload is written to `email_outbox.payload` as JSON by one version of
 * this codebase and read back by another. That is an external input by the time
 * it comes back, and it is validated like one.
 *
 * A field *spec* is how that validation stays cheap enough to actually do.
 * Each template declares its payload once:
 *
 * ```ts
 * fields: { jobRef: "text", budgetPaise: "int", url: "url", note: "text?" }
 * ```
 *
 * and TypeScript infers the payload type from it — so the enqueue call sites are
 * checked at compile time against the same declaration `parsePayload` enforces
 * at run time. One source of truth, both ends. A row whose shape no longer
 * matches lands in `failed` with the offending field named, which is a visible
 * row in a table somebody reads rather than a `undefined` rendered into a
 * client's receipt.
 */

import type { Database } from "@/types/database.types";
import type { EmailDocument } from "@/lib/email/document";

export type NotificationType = Database["public"]["Enums"]["notification_type"];

/**
 * Template ids. These are what `email_outbox.template` stores, so a value here
 * is a value in production data — rename one and the queued rows still say the
 * old thing. Add rather than rename.
 */
export type EmailTemplateId =
  // Client — spec §15
  | "payment_received"
  | "shortlist_ready"
  | "work_delivered"
  | "auto_accept_reminder"
  | "job_completed"
  | "refund_issued"
  | "dispute_update"
  // Worker — spec §15
  | "worker_selected"
  | "revision_requested"
  | "application_approved"
  | "application_rejected"
  | "payout_sent"
  | "penalty_notice";

export type FieldKind = "text" | "text?" | "int" | "int?" | "url" | "bool";

export type FieldSpec = Record<string, FieldKind>;

type FieldValue<K extends FieldKind> = K extends "text"
  ? string
  : K extends "text?"
    ? string | null
    : K extends "int"
      ? number
      : K extends "int?"
        ? number | null
        : K extends "url"
          ? string
          : K extends "bool"
            ? boolean
            : never;

export type PayloadOf<S extends FieldSpec> = { [K in keyof S]: FieldValue<S[K]> };

export class EmailPayloadError extends Error {
  constructor(template: string, field: string, problem: string) {
    super(`email payload for ${template}: ${field} ${problem}`);
    this.name = "EmailPayloadError";
  }
}

/**
 * Validate a stored payload against a spec.
 *
 * Strict on purpose. A missing field is not defaulted to an empty string —
 * "Your payment of  went through" is worse than an email that visibly failed —
 * and a number arriving as a string is a bug in the enqueue call, not something
 * to coerce quietly. Money is checked for integrality here as well as everywhere
 * else: a float that reached this point would render as `₹149.005`.
 */
export function parsePayload<S extends FieldSpec>(
  templateId: string,
  fields: S,
  raw: unknown,
): PayloadOf<S> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EmailPayloadError(templateId, "payload", "is not an object");
  }

  const source = raw as Record<string, unknown>;
  const parsed: Record<string, unknown> = {};

  for (const [name, kind] of Object.entries(fields)) {
    const value = source[name];
    const optional = kind === "text?" || kind === "int?";

    if (value === undefined || value === null) {
      if (!optional) throw new EmailPayloadError(templateId, name, "is missing");
      parsed[name] = null;
      continue;
    }

    switch (kind) {
      case "text":
      case "text?":
        if (typeof value !== "string") {
          throw new EmailPayloadError(templateId, name, "is not a string");
        }
        parsed[name] = value;
        break;

      case "int":
      case "int?":
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw new EmailPayloadError(templateId, name, "is not a whole number");
        }
        parsed[name] = value;
        break;

      case "url":
        if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
          throw new EmailPayloadError(templateId, name, "is not an http(s) URL");
        }
        parsed[name] = value;
        break;

      case "bool":
        if (typeof value !== "boolean") {
          throw new EmailPayloadError(templateId, name, "is not a boolean");
        }
        parsed[name] = value;
        break;
    }
  }

  return parsed as PayloadOf<S>;
}

export type EmailTemplate<S extends FieldSpec = FieldSpec> = {
  id: EmailTemplateId;
  /**
   * The in-site notification this event writes alongside the email. The centre
   * is out of V1 (spec §16) but the row is written now, for the reason
   * migration 0017 gives: notifications are written by the same code that sends
   * the emails, and adding the write later means revisiting every call site.
   */
  notification: NotificationType;
  /** Who reads it. `both` is the dispute case, which is one email to two sides. */
  audience: "client" | "worker" | "both";
  fields: S;
  build: (payload: PayloadOf<S>) => EmailDocument;
};

/** Declare a template. Exists to infer `S` from `fields` at each call site. */
export function defineTemplate<const S extends FieldSpec>(
  template: EmailTemplate<S>,
): EmailTemplate<S> {
  return template;
}
