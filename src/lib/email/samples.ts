/**
 * One representative payload per template.
 *
 * Two things read this and both matter. `templates.test.ts` renders every
 * sample and asserts the invariants spec §15 sets — the job reference in the
 * subject, one action, both bodies, nothing user-written left unescaped. And
 * `/dev/emails` renders them for a person to look at, because a test can prove
 * an email is well-formed and cannot tell you the sentence reads badly.
 *
 * The values are deliberately awkward rather than tidy. `₹1,499` is a real
 * bottom-slab job where the ₹25 floor bites; the job title carries an
 * apostrophe and an ampersand, which is what a client actually types and what
 * an unescaped template turns into `&amp;amp;`. The names are the shape Indian
 * display names take. A fixture of `Test Job` and `John Doe` proves nothing
 * about the day it goes out.
 *
 * The type annotation is the point of the file being TypeScript: every payload
 * is checked against its own template's field spec, so a template that gains a
 * field breaks here first.
 */

import type { EmailTemplateId } from "@/lib/email/template";
import type { EmailPayload } from "@/lib/email/templates";

const JOB_REF = "57847003";
const SITE = "https://zevi.in";

export const EMAIL_SAMPLES: { [Id in EmailTemplateId]: EmailPayload<Id> } = {
  payment_received: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    workerName: "Ananya",
    budgetPaise: 149_900,
    commissionPaise: 8_070,
    taxPaise: 1_453,
    totalPaise: 159_423,
    deadlineLabel: "Fri, 21 Aug at 6:00 pm",
    url: `${SITE}/review/${JOB_REF}`,
  },

  shortlist_ready: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    url: `${SITE}/shortlist/${JOB_REF}`,
  },

  work_delivered: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    workerName: "Ananya",
    fileCount: 3,
    windowLabel: "3 days",
    deadlineLabel: "Mon, 24 Aug at 11:20 am",
    url: `${SITE}/review/${JOB_REF}`,
  },

  auto_accept_reminder: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    workerName: "Ananya",
    remainingLabel: "12 hours left",
    deadlineLabel: "Mon, 24 Aug at 11:20 am",
    url: `${SITE}/review/${JOB_REF}`,
  },

  job_completed: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    workerName: "Ananya",
    budgetPaise: 149_900,
    // The harder of the two: a client who let the clock run out is being told
    // about something they did not do.
    autoAccepted: true,
    url: `${SITE}/review/${JOB_REF}`,
  },

  refund_issued: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    amountPaise: 134_900,
    reason: "Cancelled before half the deadline had passed",
    url: `${SITE}/dashboard`,
  },

  dispute_update: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    stage: "raised",
    detail: "The deck delivered is 8 slides against the 15 agreed in the brief.",
    url: `${SITE}/disputes/9f2c1a44-0e5b-4f1a-9d33-6b2a0c7e51aa`,
  },

  worker_selected: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    clientName: "Ravi",
    budgetPaise: 149_900,
    netPaise: 143_100,
    deadlineLabel: "Fri, 21 Aug at 6:00 pm",
    url: `${SITE}/worker/work/${JOB_REF}`,
  },

  revision_requested: {
    jobRef: JOB_REF,
    jobTitle: "Pitch deck for Ravi's D2C brand (tea & spices)",
    clientName: "Ravi",
    reason:
      "Slides 4 and 7 use the old logo, and the pricing table doesn't match the brief — ₹499 should be ₹449. Everything else is spot on.",
    url: `${SITE}/worker/work/${JOB_REF}`,
  },

  application_approved: {
    categoriesLabel: "Presentation design, Social media graphics and Logo design",
    url: `${SITE}/worker/jobs`,
  },

  application_rejected: {
    reason:
      "Two of the six samples are stock templates with the placeholder text still in them. We need work you made yourself, finished.",
    resubmitLabel: "Sat, 22 Aug at 9:00 am",
    url: `${SITE}/worker/samples`,
  },

  payout_sent: {
    amountPaise: 486_300,
    jobCount: 4,
    destinationLabel: "HDFC Bank ••••4471",
    referenceLabel: "ZEVI-PAY-20260821-0117",
    url: `${SITE}/worker/earnings`,
  },

  penalty_notice: {
    jobRef: JOB_REF,
    reason: "Delivered 2 days late",
    detail:
      "Your delivery for this job arrived after the deadline, which spec §6 treats as a late delivery. Your rating for this category has been adjusted.",
    amountPaise: null,
    url: `${SITE}/worker/earnings`,
  },
};
