/**
 * The worker's essential emails — spec §15:
 *
 *   verify email · application approved/rejected · you've been selected ·
 *   revision requested · payout sent · penalty notice
 *
 * As on the client side, **verify email** is Supabase Auth's and is not composed
 * here; see the note at the top of `client.ts` and `docs/email-setup.md`.
 *
 * A worker's email is the only channel that reaches them when they are not on
 * the site, and everything below is about money or about being allowed to earn
 * it. None of it is a nudge to come back and browse — spec §15 is explicit that
 * anything not essential belongs in the in-site notification centre.
 */

import { defineTemplate } from "@/lib/email/template";
import { formatPaise } from "@/lib/utils/money";

/**
 * Spec §4 step 5, from the other side. The client's card has already been
 * charged and the budget is in escrow before this is queued, so "the money is
 * already held" is a statement of fact rather than a reassurance.
 *
 * `netPaise` is what the worker actually receives — budget less their
 * commission share and GST on it, off the frozen `job_financials` row. Quoting
 * the budget alone would be the number they do not get.
 */
export const workerSelected = defineTemplate({
  id: "worker_selected",
  notification: "worker_selected",
  audience: "worker",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    clientName: "text",
    budgetPaise: "int",
    netPaise: "int",
    deadlineLabel: "text?",
    url: "url",
  },
  build: (p) => ({
    subject: `You've been picked for job ${p.jobRef}`,
    preheader: `${formatPaise(p.netPaise)} after commission. The client has already paid into escrow.`,
    heading: "You've been picked",
    blocks: [
      {
        kind: "paragraph",
        text: `${p.clientName} picked you for "${p.jobTitle}". You can open the brief and the attachments now.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Job", value: p.jobRef },
          { label: "Client", value: p.clientName },
          ...(p.deadlineLabel ? [{ label: "Deliver by", value: p.deadlineLabel }] : []),
          { label: "Budget", value: formatPaise(p.budgetPaise) },
          { label: "You receive", value: formatPaise(p.netPaise), strong: true },
        ],
      },
      {
        kind: "note",
        text: "The client's payment is already held in escrow. It is released to you when they accept the work, or automatically if they don't respond in time.",
      },
    ],
    action: { label: "Open the job", url: p.url },
  }),
});

/**
 * Spec §5's one free revision. The client's reason is quoted verbatim — it is
 * the entire content of this email, and paraphrasing it into our own voice would
 * put words in a client's mouth in a message that may end up in a dispute.
 */
export const revisionRequested = defineTemplate({
  id: "revision_requested",
  notification: "revision_requested",
  audience: "worker",
  fields: {
    jobRef: "text",
    jobTitle: "text",
    clientName: "text",
    reason: "text",
    url: "url",
  },
  build: (p) => ({
    subject: `Revision requested on job ${p.jobRef}`,
    preheader: `${p.clientName} asked for a change to "${p.jobTitle}".`,
    heading: "The client asked for a change",
    blocks: [
      {
        kind: "paragraph",
        text: `${p.clientName} has asked for a revision on "${p.jobTitle}". Here's what they said:`,
      },
      { kind: "quote", text: p.reason },
      {
        kind: "note",
        text: "This is the one free revision. Deliver again from the job page — the review clock starts over when you do.",
      },
    ],
    action: { label: "Open the job", url: p.url },
  }),
});

/** Spec §6's first gate, passed. The feed is the only thing worth linking to. */
export const applicationApproved = defineTemplate({
  id: "application_approved",
  notification: "application_approved",
  audience: "worker",
  fields: {
    categoriesLabel: "text",
    url: "url",
  },
  build: (p) => ({
    subject: "You're approved to work on Zevi",
    preheader: "Your samples were approved. Jobs in your categories are open to you now.",
    heading: "You're approved",
    blocks: [
      {
        kind: "paragraph",
        text: `Your samples were approved for ${p.categoriesLabel}. Jobs in those categories are in your feed now.`,
      },
      {
        kind: "note",
        text: "You can opt in to five jobs at a time. Read the brief properly before you do — clients see how quickly you opted in, and your answers are all they have to pick you on.",
      },
    ],
    action: { label: "See open jobs", url: p.url },
  }),
});

/**
 * Spec §6's first gate, failed. One resubmission, seven days later, and the
 * reviewer's reason is quoted rather than summarised: a rejection a worker
 * cannot act on is a worker who resubmits the same portfolio.
 *
 * `resubmitLabel` is null when the decision was final.
 */
export const applicationRejected = defineTemplate({
  id: "application_rejected",
  notification: "application_rejected",
  audience: "worker",
  fields: {
    reason: "text?",
    resubmitLabel: "text?",
    url: "url",
  },
  build: (p) => ({
    subject: "About your Zevi application",
    preheader: p.resubmitLabel
      ? `You can submit new samples from ${p.resubmitLabel}.`
      : "Your samples weren't approved this time.",
    heading: "Your samples weren't approved",
    blocks: [
      {
        kind: "paragraph",
        text: "A reviewer looked at your samples and couldn't approve them this time.",
      },
      ...(p.reason ? [{ kind: "quote" as const, text: p.reason }] : []),
      {
        kind: "note",
        text: p.resubmitLabel
          ? `You can replace your samples and submit once more from ${p.resubmitLabel}. Pick work you made yourself, finished, and would show a paying client.`
          : "This decision is final for this account.",
      },
    ],
    ...(p.resubmitLabel ? { action: { label: "Update your samples", url: p.url } } : {}),
  }),
});

/**
 * Spec §6's payout, and the money actually leaving. **Nothing calls this yet.**
 *
 * `build_payout_batch()` assembles a batch and stops; the disbursement step that
 * turns a `payouts` row into a bank transfer and writes `payout_paid` to the
 * ledger is the one thing still standing between this platform and a worker
 * holding the money. The template is written and tested so that step has nothing
 * left to invent — it queues this with the batch's reference and the fund
 * account it went to.
 */
export const payoutSent = defineTemplate({
  id: "payout_sent",
  notification: "payout_sent",
  audience: "worker",
  fields: {
    amountPaise: "int",
    jobCount: "int",
    destinationLabel: "text",
    referenceLabel: "text?",
    url: "url",
  },
  build: (p) => ({
    subject: `${formatPaise(p.amountPaise)} is on its way to you`,
    preheader: `${p.jobCount === 1 ? "1 job" : `${p.jobCount} jobs`}, paid to ${p.destinationLabel}.`,
    heading: "Your payout has been sent",
    blocks: [
      {
        kind: "paragraph",
        text: `We've sent ${formatPaise(p.amountPaise)} for ${p.jobCount === 1 ? "1 completed job" : `${p.jobCount} completed jobs`}.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Amount", value: formatPaise(p.amountPaise), strong: true },
          { label: "Sent to", value: p.destinationLabel },
          ...(p.referenceLabel ? [{ label: "Reference", value: p.referenceLabel }] : []),
        ],
      },
      {
        kind: "note",
        text: "Bank transfers usually land the same working day. If it hasn't arrived in two, check that your account details are still current on your earnings page.",
      },
    ],
    action: { label: "See your earnings", url: p.url },
  }),
});

/**
 * Spec §6's penalties — a late delivery, an abandonment, a plagiarism finding.
 * **Nothing calls this yet either**: nothing on the platform writes a
 * `worker_adjustments` row, which is the same reason migration 0031 gives for
 * not charging the ₹15 dispute fee. A penalty email nobody was actually charged
 * for would be worse than none.
 *
 * `amountPaise` is null for the penalties that are not money — a rating delta,
 * a cap on the next job — because those are most of them.
 */
export const penaltyNotice = defineTemplate({
  id: "penalty_notice",
  notification: "penalty_notice",
  audience: "worker",
  fields: {
    jobRef: "text?",
    reason: "text",
    detail: "text",
    amountPaise: "int?",
    url: "url",
  },
  build: (p) => ({
    subject: p.jobRef ? `A penalty was applied — job ${p.jobRef}` : "A penalty was applied to your account",
    preheader: p.reason,
    heading: "A penalty has been applied",
    blocks: [
      { kind: "paragraph", text: p.detail },
      {
        kind: "facts",
        rows: [
          ...(p.jobRef ? [{ label: "Job", value: p.jobRef }] : []),
          { label: "Reason", value: p.reason },
          ...(p.amountPaise === null
            ? []
            : [{ label: "Amount", value: formatPaise(p.amountPaise), strong: true }]),
        ],
      },
      {
        kind: "note",
        text: "If you think this is wrong, reply to this email within 7 days and a person will look at it.",
      },
    ],
    action: { label: "See your earnings", url: p.url },
  }),
});
