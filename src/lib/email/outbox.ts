/**
 * The outbox: putting an email in it, and taking it out again.
 *
 * **Server-only, and deliberately not a Server Action.** Every export here is
 * called from code that has already established who is acting; a `"use server"`
 * file would hand the browser a URL that sends Zevi-branded mail to any address
 * it can name a profile for.
 *
 * ### Why nothing here throws
 *
 * `queueEmail` is called from the middle of money paths — settlement,
 * acceptance, a dispute decision. Those are transactions that have already
 * happened by the time the email is queued, and there is no version of "the
 * receipt could not be queued" that should unwind one. So every failure is
 * caught and logged, and the caller is told nothing, because there is nothing
 * the caller could usefully do. The row in `email_outbox` is the record; a
 * missing row is a bug that shows up as a missing email, which is exactly the
 * class of problem `email_outbox_failures_idx` exists to make visible.
 *
 * The one thing that is *not* swallowed is a bad payload: the document is built
 * before the insert, so a template whose fields do not match its call site fails
 * here, in development, on the first call — not three weeks later in a drain
 * nobody is watching.
 */

import {
  EMAIL_BATCH_SIZE,
  emailRetryDelaySeconds,
} from "@/lib/constants/email";
import {
  EMAIL_TEMPLATES,
  buildDocument,
  isEmailTemplateId,
  renderTemplate,
} from "@/lib/email/templates";
import { deliverEmail } from "@/lib/email/send";
import { SesError } from "@/lib/email/ses";
import type { EmailTemplateId } from "@/lib/email/template";
import type { EmailPayload } from "@/lib/email/templates";
import { createServiceRoleClient } from "@/lib/supabase/server";

export type QueueEmailInput<Id extends EmailTemplateId> = {
  template: Id;
  /** Who reads it. The address is looked up from the profile, never passed in. */
  profileId: string;
  payload: EmailPayload<Id>;
  jobId?: string;
  /**
   * What makes this event unique. Two enqueues with the same key produce one
   * email — which is what the browser and the Razorpay webhook both settling a
   * payment needs, and what stops a second worker opting in from sending a
   * second "you have workers" email.
   *
   * Leave it out only when the event genuinely cannot repeat.
   */
  dedupeKey?: string;
  /** For mail that should not go out yet. Defaults to now. */
  scheduledFor?: Date;
};

/**
 * Queue one email and the in-site notification that goes with it.
 *
 * Both rows or neither — `enqueue_email()` writes them in one transaction, and
 * skips both when the dedupe key has already been used or the profile has been
 * anonymised.
 */
export async function queueEmail<Id extends EmailTemplateId>(
  input: QueueEmailInput<Id>,
): Promise<void> {
  // Rendered here rather than at send time so a mismatched payload is a loud
  // failure at the call site. Also gives the subject the outbox row stores and
  // the title the notification needs, from one build.
  const doc = buildDocument(input.template, input.payload);

  const actionPath = doc.action ? pathOf(doc.action.url) : null;
  const summary = doc.blocks.find((block) => block.kind === "paragraph");

  const admin = createServiceRoleClient();

  const { error } = await admin.rpc("enqueue_email", {
    p_profile_id: input.profileId,
    p_template: input.template,
    p_subject: doc.subject,
    p_payload: input.payload,
    ...(input.jobId ? { p_job_id: input.jobId } : {}),
    ...(input.dedupeKey ? { p_dedupe_key: input.dedupeKey } : {}),
    ...(input.scheduledFor ? { p_scheduled_for: input.scheduledFor.toISOString() } : {}),
    // Every template declares the in-site notification it writes alongside.
    p_notification_type: EMAIL_TEMPLATES[input.template].notification,
    p_notification_title: doc.heading,
    ...(summary ? { p_notification_body: summary.text } : {}),
    ...(actionPath ? { p_action_url: actionPath } : {}),
  });

  if (error) {
    console.error(
      `[email] could not queue ${input.template} for ${input.profileId}: ${error.message}`,
    );
  }
}

/** The in-site link, which is a path — the email's is absolute. */
function pathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export type DrainSummary = {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
};

/**
 * Send what is due.
 *
 * Sequential on purpose. SES enforces a per-second sending rate on every
 * account — 14/s to start, lower on a new one — and a `Promise.all` over
 * twenty-five messages is the shape that trips it. One at a time is fast
 * enough for mail nobody is watching a spinner for, and it means a throttle
 * that does arrive costs one message rather than a batch.
 *
 * Each row is claimed with its attempt already counted, so nothing below can
 * cause an infinite retry: the worst case is `email.max_attempts` sends of a
 * message that kills the drain, and then a `failed` row somebody can read.
 */
export async function drainOutbox(limit: number = EMAIL_BATCH_SIZE): Promise<DrainSummary> {
  const admin = createServiceRoleClient();

  const { data: claimed, error } = await admin.rpc("claim_email_batch", { p_limit: limit });

  if (error) {
    console.error(`[email] could not claim a batch: ${error.message}`);
    throw new Error(error.message);
  }

  const summary: DrainSummary = {
    claimed: claimed?.length ?? 0,
    sent: 0,
    retrying: 0,
    failed: 0,
  };

  for (const row of claimed ?? []) {
    try {
      if (!isEmailTemplateId(row.template)) {
        // A template that was removed while its rows were still queued. Not
        // retryable — the code that could render it is gone.
        throw new SesError(`no template named ${row.template}`, {
          status: 400,
          code: "UnknownTemplate",
        });
      }

      const rendered = renderTemplate(row.template, row.payload);

      const messageId = await deliverEmail({
        to: row.to_email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        tags: { template: row.template, outbox: row.id },
      });

      const { error: sentError } = await admin.rpc("mark_email_sent", {
        p_id: row.id,
        p_message_id: messageId,
      });

      if (sentError) {
        // Sent, but not recorded. The row stays `sending` and goes stale in
        // fifteen minutes, at which point it is sent again — a duplicate
        // receipt, which is the better half of this trade.
        console.error(`[email] sent ${row.id} but could not record it: ${sentError.message}`);
      }

      summary.sent += 1;
    } catch (cause) {
      const retryable = cause instanceof SesError ? cause.retryable : true;
      const reason = cause instanceof Error ? cause.message : "unknown error";

      const retryAt = retryable
        ? new Date(Date.now() + emailRetryDelaySeconds(row.attempts) * 1000)
        : null;

      const { data: status } = await admin.rpc("mark_email_failed", {
        p_id: row.id,
        p_error: reason,
        ...(retryAt ? { p_retry_at: retryAt.toISOString() } : {}),
      });

      if (status === "queued") {
        summary.retrying += 1;
        console.warn(`[email] ${row.template} ${row.id} failed, retrying: ${reason}`);
      } else {
        summary.failed += 1;
        console.error(
          `[email] ${row.template} ${row.id} failed after ${row.attempts} attempt(s): ${reason}`,
        );
      }
    }
  }

  return summary;
}
