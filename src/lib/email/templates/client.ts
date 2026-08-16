/**
 * The client's essential emails — spec §15:
 *
 *   verify email · payment received · shortlist ready · worker assigned ·
 *   work delivered · auto-accept reminder · job completed · refund issued ·
 *   dispute update
 *
 * Two of those nine are not files in this folder, and both are decisions rather
 * than omissions:
 *
 * **verify email** is Supabase Auth's. `signUp` sends the confirmation link and
 * `/auth/callback` exchanges it; nothing in this codebase composes that message,
 * so a template here would be a body nobody sends. The way it gets the SPF and
 * DKIM that spec §15 is really asking for is Supabase's custom SMTP pointing at
 * SES — `docs/email-setup.md` covers it, and `npm run email:preview` writes the
 * branded HTML to paste into the Supabase dashboard so it looks like the rest.
 *
 * **worker assigned** is the same instant as payment received. Spec §4 charges
 * the card at selection and migration 0029 settles the capture, the escrow hold,
 * the ledger and the assignment in one transaction — so the two emails would
 * arrive in the same second, about the same event, one of them saying less. The
 * receipt below carries the worker's name and the deadline, which is everything
 * the second one would have said. If assignment ever stops coinciding with
 * payment, this is where the second template goes.
 */

import { RETENTION_DAYS_ACCEPTED } from "@/lib/constants/deliveries";
import { defineTemplate } from "@/lib/email/template";
import { formatPaise } from "@/lib/utils/money";

/**
 * Spec §4 step 5, the moment the job stops being a posting.
 *
 * A receipt, so every line stands on its own: budget, commission and GST are
 * never folded into one number (spec §8, and it is a tax requirement as much as
 * a design one). The figures come from `job_financials`, frozen before the card
 * was charged — this template formats them and computes nothing.
 */
export const paymentReceived = defineTemplate({
  id: "payment_received",
  notification: "payment_received",
  audience: "client",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    workerName: "text",
    budgetPaise: "int",
    commissionPaise: "int",
    taxPaise: "int",
    totalPaise: "int",
    deadlineLabel: "text?",
    url: "url",
  },
  build: (p) => ({
    subject: `Payment received — ${p.workerName} is on job ${p.jobRef}`,
    preheader: `${formatPaise(p.totalPaise)} charged. The budget is held in escrow until you accept the work.`,
    heading: "Your payment went through",
    blocks: [
      {
        kind: "paragraph",
        text: `${p.workerName} has been assigned to "${p.jobTitle}" and can start now.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Job", value: p.jobRef },
          { label: "Worker", value: p.workerName },
          ...(p.deadlineLabel ? [{ label: "Due", value: p.deadlineLabel }] : []),
          { label: "Budget (held in escrow)", value: formatPaise(p.budgetPaise) },
          { label: "Zevi commission", value: formatPaise(p.commissionPaise) },
          { label: "GST", value: formatPaise(p.taxPaise) },
          { label: "Total charged", value: formatPaise(p.totalPaise), strong: true },
        ],
      },
      {
        kind: "note",
        text: "Zevi holds the budget until you accept the work. The worker is paid after that, not before.",
      },
    ],
    action: { label: "View the job", url: p.url },
  }),
});

/**
 * Workers have opted in and there is a decision to make.
 *
 * Sent once per job, on the first opt-in — the dedupe key is the job, so a
 * second worker joining does not send a second email. A client who posts a job
 * and hears nothing assumes the platform is empty (spec §17's whole worry), and
 * a client emailed five times in an hour learns to filter us.
 */
export const shortlistReady = defineTemplate({
  id: "shortlist_ready",
  notification: "shortlist_ready",
  audience: "client",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    url: "url",
  },
  build: (p) => ({
    subject: `Workers are ready for job ${p.jobRef}`,
    preheader: `Someone has opted in to "${p.jobTitle}". Nobody is charged until you pick.`,
    heading: "You have workers to look at",
    blocks: [
      {
        kind: "paragraph",
        text: `Workers have opted in to "${p.jobTitle}". You can read their answers and see their past work side by side.`,
      },
      {
        kind: "note",
        text: "Nothing is charged until you pick someone. More workers may opt in while you decide.",
      },
    ],
    action: { label: "Review workers", url: p.url },
  }),
});

/** Spec §4 step 7. The clock in the note is the one stored on the delivery. */
export const workDelivered = defineTemplate({
  id: "work_delivered",
  notification: "work_delivered",
  audience: "client",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    workerName: "text",
    fileCount: "int",
    windowLabel: "text",
    deadlineLabel: "text",
    url: "url",
  },
  build: (p) => ({
    subject: `${p.workerName} delivered job ${p.jobRef}`,
    preheader: `You have ${p.windowLabel} to accept or ask for a change.`,
    heading: "Your work has been delivered",
    blocks: [
      {
        kind: "paragraph",
        text: `${p.workerName} has delivered ${p.fileCount === 1 ? "1 file" : `${p.fileCount} files`} for "${p.jobTitle}". Previews are watermarked until you accept.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Job", value: p.jobRef },
          { label: "Delivered by", value: p.workerName },
          { label: "Review by", value: p.deadlineLabel, strong: true },
        ],
      },
      {
        kind: "note",
        text: `You have ${p.windowLabel} to accept or ask for the one free revision. If you do nothing, it is accepted automatically on ${p.deadlineLabel} and the worker is paid.`,
      },
    ],
    action: { label: "Review the delivery", url: p.url },
  }),
});

/**
 * Spec §5's nudge. Sent by the hourly sweep at a third and five sixths of the
 * window — the "12h/30h and 24h/60h" in the spec, which are those two fractions
 * of its two windows.
 *
 * The point of this email is the sentence in the note. A client who reads
 * nothing else should still know that silence has a consequence and what it is.
 */
export const autoAcceptReminder = defineTemplate({
  id: "auto_accept_reminder",
  notification: "auto_accept_reminder",
  audience: "client",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    workerName: "text",
    remainingLabel: "text",
    deadlineLabel: "text",
    url: "url",
  },
  build: (p) => ({
    subject: `${p.remainingLabel} to review job ${p.jobRef}`,
    preheader: `"${p.jobTitle}" is accepted automatically on ${p.deadlineLabel}.`,
    heading: "Your delivery is waiting",
    blocks: [
      {
        kind: "paragraph",
        text: `${p.workerName} delivered "${p.jobTitle}" and it hasn't been looked at yet.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Job", value: p.jobRef },
          { label: "Time left", value: p.remainingLabel, strong: true },
          { label: "Accepted automatically on", value: p.deadlineLabel },
        ],
      },
      {
        kind: "note",
        text: "If you do nothing, the delivery is accepted for you and the worker is paid. You can still accept early or ask for the one free revision before then.",
      },
    ],
    action: { label: "Review the delivery", url: p.url },
  }),
});

/**
 * Acceptance, by a click or by the clock.
 *
 * `autoAccepted` changes the first paragraph rather than splitting the
 * template: a client who let the window run out is being told something they
 * did not do, and burying that in the same sentence as a normal acceptance is
 * how a support ticket starts.
 *
 * The retention line is spec §12's, and it is why this email exists at all for
 * an auto-accepted job — files go seven days after acceptance, so the one
 * message telling somebody to download them has to arrive.
 */
export const jobCompleted = defineTemplate({
  id: "job_completed",
  notification: "job_completed",
  audience: "client",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    workerName: "text",
    budgetPaise: "int",
    autoAccepted: "bool",
    url: "url",
  },
  build: (p) => ({
    subject: `Job ${p.jobRef} is complete`,
    preheader: `Download your files — they're removed ${RETENTION_DAYS_ACCEPTED} days after acceptance.`,
    heading: p.autoAccepted ? "Your job was accepted automatically" : "Your job is complete",
    blocks: [
      {
        kind: "paragraph",
        text: p.autoAccepted
          ? `The review window on "${p.jobTitle}" ran out, so the delivery was accepted for you and ${p.workerName} has been paid from escrow.`
          : `You accepted the delivery for "${p.jobTitle}". ${p.workerName} has been paid from escrow.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Job", value: p.jobRef },
          { label: "Worker", value: p.workerName },
          { label: "Released to the worker", value: formatPaise(p.budgetPaise), strong: true },
        ],
      },
      {
        kind: "note",
        text: `Your files are unlocked and unwatermarked. Download them within ${RETENTION_DAYS_ACCEPTED} days — after that they're removed from our storage.`,
      },
    ],
    action: { label: "Download your files", url: p.url },
  }),
});

/**
 * Spec §14. Sent when a refund is actually issued to the gateway, which is a
 * step this platform does not have yet — Razorpay's refund API is unwired, so a
 * cancellation and a decided dispute both leave a `pending` `refunds` row and
 * nothing calls this. That is why the copy promises the bank's 5–7 working days
 * from *now* rather than from the decision: when the caller lands, the email
 * goes out at the moment the money leaves, not the moment it was owed.
 */
export const refundIssued = defineTemplate({
  id: "refund_issued",
  notification: "refund_issued",
  audience: "client",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    amountPaise: "int",
    reason: "text",
    url: "url",
  },
  build: (p) => ({
    subject: `${formatPaise(p.amountPaise)} refunded for job ${p.jobRef}`,
    preheader: "It goes back to the card or account you paid with, in 5–7 working days.",
    heading: "Your refund is on its way",
    blocks: [
      {
        kind: "paragraph",
        text: `We've refunded ${formatPaise(p.amountPaise)} for "${p.jobTitle}".`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Job", value: p.jobRef },
          { label: "Reason", value: p.reason },
          { label: "Refunded", value: formatPaise(p.amountPaise), strong: true },
        ],
      },
      {
        kind: "note",
        text: "Refunds go back to the original payment method and take 5–7 working days to appear, depending on your bank. Zevi absorbs the payment gateway's fee.",
      },
    ],
    action: { label: "View the job", url: p.url },
  }),
});

/**
 * Spec §11, and the one template both sides receive — which is why the copy
 * never says "you" about who raised it. `stage` decides the sentence:
 *
 *   raised     a case was opened on this job; escrow is frozen
 *   response   the other side has answered; it is with a reviewer now
 *   resolved   a decision has been made, and `detail` carries it
 *
 * An unknown stage still renders — a queued row from an older deploy is worth
 * sending as a plain "there's an update" rather than failing. `detail` is
 * whatever a person wrote and is rendered as a quote, never as our own words.
 */
export const disputeUpdate = defineTemplate({
  id: "dispute_update",
  notification: "dispute_update",
  audience: "both",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    stage: "text",
    detail: "text?",
    url: "url",
  },
  build: (p) => {
    const copy =
      p.stage === "raised"
        ? {
            heading: "A dispute was opened on your job",
            body: `A dispute has been opened on "${p.jobTitle}". The money is frozen in escrow and the delivery clock has stopped while it's looked at.`,
            note: "You have 24 hours to add your side of it. After that a Zevi reviewer decides with whatever is on the case — a statement sent late is still read, but the wait isn't extended.",
          }
        : p.stage === "response"
          ? {
              heading: "The other side has responded",
              body: `Both statements on "${p.jobTitle}" are now with a Zevi reviewer.`,
              note: "You'll get one more email when a decision is made. Nothing else is needed from you.",
            }
          : p.stage === "resolved"
            ? {
                heading: "Your dispute has been decided",
                body: `A Zevi reviewer has decided the dispute on "${p.jobTitle}".`,
                note: "Any money owed to you is released within one working day. Refunds to a card or bank account take a further 5–7 working days to appear.",
              }
            : {
                heading: "There's an update on your dispute",
                body: `The dispute on "${p.jobTitle}" has moved on.`,
                note: "Open the case to read where it stands.",
              };

    return {
      subject: `Dispute update — job ${p.jobRef}`,
      preheader: copy.body,
      heading: copy.heading,
      blocks: [
        { kind: "paragraph", text: copy.body },
        ...(p.detail ? [{ kind: "quote" as const, text: p.detail }] : []),
        { kind: "note", text: copy.note },
      ],
      action: { label: "Open the case", url: p.url },
    };
  },
});
