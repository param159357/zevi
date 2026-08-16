/**
 * The registry — every essential email spec §15 names, in one object.
 *
 * Two things read it. `lib/email/outbox.ts` uses it at enqueue time, where the
 * template id picks the payload type and the compiler checks the call site; and
 * the drain uses `renderTemplate` at send time, where the id is a string that
 * came out of a `text` column and everything has to be re-established.
 *
 * The count is thirteen for fifteen bullets in the spec: **verify email** is
 * Supabase Auth's message rather than one we compose, and **worker assigned** is
 * the same instant as **payment received**. Both are explained at the top of
 * `client.ts`, and both are decisions to be argued with rather than gaps.
 */

import { renderEmail, type RenderedEmail } from "@/lib/email/render";
import {
  autoAcceptReminder,
  disputeUpdate,
  jobCompleted,
  paymentReceived,
  refundIssued,
  shortlistReady,
  workDelivered,
} from "@/lib/email/templates/client";
import {
  applicationApproved,
  applicationRejected,
  payoutSent,
  penaltyNotice,
  revisionRequested,
  workerSelected,
} from "@/lib/email/templates/worker";
import {
  type EmailDocument,
} from "@/lib/email/document";
import {
  type EmailTemplateId,
  type PayloadOf,
  parsePayload,
} from "@/lib/email/template";

export const EMAIL_TEMPLATES = {
  // Client
  payment_received: paymentReceived,
  shortlist_ready: shortlistReady,
  work_delivered: workDelivered,
  auto_accept_reminder: autoAcceptReminder,
  job_completed: jobCompleted,
  refund_issued: refundIssued,
  dispute_update: disputeUpdate,
  // Worker
  worker_selected: workerSelected,
  revision_requested: revisionRequested,
  application_approved: applicationApproved,
  application_rejected: applicationRejected,
  payout_sent: payoutSent,
  penalty_notice: penaltyNotice,
} as const;

/**
 * Compile-time completeness: adding an id to `EmailTemplateId` without adding
 * its template here is an error in this file rather than a runtime lookup that
 * returns undefined. That every template is filed under *its own* id is checked
 * at runtime instead, in `templates.test.ts` — the type system can see the keys
 * but not that they agree with the `id` fields.
 */
type Registry = typeof EMAIL_TEMPLATES;
export type AssertComplete<T extends Record<EmailTemplateId, { id: EmailTemplateId }>> = T;
export type CheckedRegistry = AssertComplete<Registry>;

/** The payload one template takes, for the enqueue call sites. */
export type EmailPayload<Id extends EmailTemplateId> = PayloadOf<Registry[Id]["fields"]>;

export function isEmailTemplateId(value: string): value is EmailTemplateId {
  return Object.hasOwn(EMAIL_TEMPLATES, value);
}

/**
 * Build one template's document from a stored payload.
 *
 * The cast is the whole dynamic boundary of this module, and it is one line
 * wide. `EMAIL_TEMPLATES[id]` is a union of thirteen templates whose `build`
 * functions take thirteen different payloads, so TypeScript will not call it
 * with anything; what makes it safe is the line above, which validated the raw
 * JSON against *that same template's* field spec and threw if it did not match.
 */
export function buildDocument(id: EmailTemplateId, raw: unknown): EmailDocument {
  const template = EMAIL_TEMPLATES[id];
  const payload: Record<string, unknown> = parsePayload(template.id, template.fields, raw);
  const build = template.build as (checked: Record<string, unknown>) => EmailDocument;

  return build(payload);
}

/** What the drain sends, and what the preview script writes to disk. */
export function renderTemplate(id: EmailTemplateId, raw: unknown): RenderedEmail {
  return renderEmail(buildDocument(id, raw));
}
