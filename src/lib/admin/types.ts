/**
 * The shapes the admin console's actions and queries take and return.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */

import type { SampleStatus, WorkerStatus } from "@/lib/workers/types";

/** Spec §6: approve · reject with reason · approve-with-flag. */
export const REVIEW_DECISIONS = ["approve", "approve_with_flag", "reject"] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly unknown[]).includes(value);
}

/** A row in the queue, ordered by what is closest to breaching its SLA. */
export type ApprovalQueueRow = {
  applicationId: string;
  workerId: string;
  workerName: string;
  attempt: number;
  submittedAt: string | null;
  slaDueAt: string | null;
  categoryNames: string[];
  sampleCount: number;
};

export type ReviewSample = {
  id: string;
  caption: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: SampleStatus;
  /** Short-lived, minted server-side. Null if the object has gone. */
  previewUrl: string | null;
  /** Spec §6: reverse image search on design samples. Images only. */
  reverseSearchUrl: string | null;
};

export type ReviewCategory = {
  id: string;
  name: string;
  sampleMin: number;
  sampleMax: number;
  formatNote: string | null;
  samples: ReviewSample[];
};

/** One application, as the review screen needs it. */
export type ApplicationReview = {
  applicationId: string;
  workerId: string;
  /** Full legal name — spec §6 has the reviewer check it against the ID. */
  workerName: string;
  workerEmail: string;
  workerStatus: WorkerStatus;
  memberSince: string;
  attempt: number;
  status: string;
  submittedAt: string | null;
  slaDueAt: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  categories: ReviewCategory[];
};

export type ReviewFormState = {
  status: "idle" | "error";
  error?: string;
  fieldErrors?: Record<string, string>;
};

export const IDLE_REVIEW_STATE: ReviewFormState = { status: "idle" };

// ---------------------------------------------------------------------------
// The work queue home (spec §7)
// ---------------------------------------------------------------------------

/**
 * The five things spec §7 names as "what's rotting", in the order it names
 * them. Each is its own module's overdue tail, and the home screen is the only
 * place they are seen together.
 */
export const QUEUE_KINDS = [
  "disputes",
  "approvals",
  "expiring_jobs",
  "failed_payouts",
  "reports",
] as const;

export type QueueKind = (typeof QUEUE_KINDS)[number];

/** One line on the home screen: a count, the worst deadline in it, and where
 *  to go. `href` is null when the module behind it is not built. */
export type QueueSummary = {
  kind: QueueKind;
  label: string;
  /** How many are waiting. */
  count: number;
  /** How many of those are already past their deadline. */
  overdue: number;
  /** The deadline closest to breaching, or null when nothing has one. */
  nextDueAt: string | null;
  href: string | null;
  /** Said in words when `count` is zero, so an empty queue reads as reassurance
   *  rather than as a missing feature. */
  emptyNote: string;
};

// ---------------------------------------------------------------------------
// Disputes (spec §7, §11)
// ---------------------------------------------------------------------------

/** Spec §11: "Three outcomes only: release · refund · split." */
export const DISPUTE_OUTCOMES = ["release", "refund", "split"] as const;

export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export function isDisputeOutcome(value: unknown): value is DisputeOutcome {
  return (DISPUTE_OUTCOMES as readonly unknown[]).includes(value);
}

export type DisputeQueueRow = {
  disputeId: string;
  jobId: string;
  jobTitle: string;
  raisedByName: string;
  raisedByRole: string;
  status: string;
  layer: string;
  reasonSummary: string;
  amountPaise: number;
  openedAt: string;
  /** Spec §11: 48h to first response, 5 days to decision. Both are stored, so
   *  the queue orders by what is closest to breaching rather than by age. */
  firstResponseDueAt: string;
  firstRespondedAt: string | null;
  decisionDueAt: string;
};

/** One statement, from one side. */
export type DisputeStatement = {
  id: string;
  authorName: string;
  authorRole: string;
  body: string;
  isAppeal: boolean;
  createdAt: string;
};

/** What each party has done on the platform before this case. Spec §7 puts
 *  both histories on the dispute screen for exactly this reason. */
export type DisputeParty = {
  profileId: string;
  displayName: string;
  role: "client" | "worker";
  jobsCompleted: number;
  jobsCancelled: number | null;
  rating: number | null;
  ratingCount: number;
  memberSince: string | null;
  /** Admin-only counters, from `user_private_stats`. Null when the reviewer's
   *  role cannot read that table. */
  disputesRaised: number | null;
  disputesAgainst: number | null;
  disputesLost: number | null;
};

export type DisputeMessage = {
  id: string;
  senderRole: string;
  body: string;
  redactionCount: number;
  createdAt: string;
};

export type DisputeFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Which side put it in front of the reviewer. */
  source: "delivery" | "attachment" | "evidence";
  url: string | null;
};

/** One case, as the decision screen needs it: brief, files, chat, both
 *  statements, both histories (spec §7). */
export type DisputeCase = {
  disputeId: string;
  jobId: string;
  jobTitle: string;
  jobDescription: string;
  jobStatus: string;
  categoryName: string | null;
  budgetPaise: number;
  deadlineAt: string | null;
  deliveredAt: string | null;
  status: string;
  layer: string;
  outcome: string | null;
  splitClientBps: number | null;
  decisionNote: string | null;
  decidedAt: string | null;
  reasonSummary: string;
  amountPaise: number;
  openedAt: string;
  firstResponseDueAt: string;
  decisionDueAt: string;
  responseDueAt: string;
  raisedByRole: string;
  /** What is actually still in escrow. Null when the hold is settled — which is
   *  what `resolve_dispute()` refuses on, so the screen says it first. */
  escrowHeldPaise: number | null;
  escrowStatus: string | null;
  /**
   * Spec §5's 70% ceiling, set when a cancellation more than half way through
   * the deadline opened this case. Null on an ordinary dispute — §11 caps
   * nothing when the complaint is about the work itself.
   *
   * The form reads it to take the outcomes it forbids off the screen, and
   * `resolve_dispute()` refuses them again if one arrives anyway. Two checks,
   * because a disabled radio button is not a rule.
   */
  clientRefundCapBps: number | null;
  client: DisputeParty | null;
  worker: DisputeParty | null;
  statements: DisputeStatement[];
  messages: DisputeMessage[];
  files: DisputeFile[];
};

export type DisputeFormState = {
  status: "idle" | "error";
  error?: string;
  fieldErrors?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Users (spec §7)
// ---------------------------------------------------------------------------

/** Spec §7's three: "Warn · suspend · ban." The other three `sanction_type`
 *  values belong to the penalty system, which is not built — and
 *  `apply_user_sanction()` refuses them by name rather than recording one that
 *  does nothing. */
export const SANCTION_TYPES = ["warning", "suspension", "ban"] as const;

export type SanctionType = (typeof SANCTION_TYPES)[number];

export function isSanctionType(value: unknown): value is SanctionType {
  return (SANCTION_TYPES as readonly unknown[]).includes(value);
}

export type UserSearchRow = {
  profileId: string;
  fullName: string;
  email: string;
  status: string;
  isClient: boolean;
  isWorker: boolean;
  createdAt: string;
};

export type UserSanction = {
  id: string;
  type: string;
  reason: string;
  internalNote: string | null;
  startsAt: string;
  endsAt: string | null;
  liftedAt: string | null;
  createdAt: string;
};

export type UserJob = {
  id: string;
  title: string;
  status: string;
  budgetPaise: number;
  role: "client" | "worker";
  createdAt: string;
};

/** One account, as spec §7's Users module describes it: "Full history, ratings,
 *  disputes, cancellations, earnings, KYC." */
export type UserDetail = {
  profileId: string;
  fullName: string;
  displayName: string | null;
  email: string;
  mobile: string | null;
  emailVerifiedAt: string | null;
  mobileVerifiedAt: string | null;
  status: string;
  statusReason: string | null;
  suspendedUntil: string | null;
  isClient: boolean;
  isWorker: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  /** True when this account is in the console. `apply_user_sanction()` refuses
   *  those, so the screen hides the form rather than offering a button that
   *  comes back with an error. */
  isAdmin: boolean;

  client: {
    rating: number | null;
    ratingCount: number;
    jobsPosted: number;
    jobsCompleted: number;
    jobsCancelled: number;
    totalSpendPaise: number;
  } | null;

  worker: {
    status: string;
    tier: string;
    rating: number | null;
    ratingCount: number;
    jobsCompleted: number;
    activeOptIns: number;
    kycStatus: string | null;
    earningsFrozen: boolean;
    outstandingDebitPaise: number;
    jobsAbandoned: number;
    lifetimeEarningsPaise: number;
    paidPaise: number;
    pendingPaise: number;
  } | null;

  privateStats: {
    disputesRaised: number;
    disputesAgainst: number;
    disputesLost: number;
    disputeRateBps: number;
    chargebacks: number;
    reportsAgainst: number;
    riskScore: number;
  } | null;

  sanctions: UserSanction[];
  jobs: UserJob[];
};

export type SanctionFormState = {
  status: "idle" | "error";
  error?: string;
  fieldErrors?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Payouts (spec §7, §14)
// ---------------------------------------------------------------------------

export type PayoutBatchRow = {
  id: string;
  cutoffAt: string;
  scheduledPayAt: string;
  status: string;
  totalPaise: number;
  itemCount: number;
  payoutCount: number;
  reviewedAt: string | null;
  failureNote: string | null;
};

/** One worker's line in a batch. */
export type PayoutLine = {
  payoutId: string;
  workerId: string;
  workerName: string;
  amountPaise: number;
  status: string;
  itemCount: number;
  /** Where it is going — masked, because the full account number was never
   *  stored (0033). */
  destination: string | null;
  destinationVerifiedAt: string | null;
  failureReason: string | null;
};

export type PayoutBatchDetail = PayoutBatchRow & {
  lines: PayoutLine[];
};

/** Spec §14's failed-payout queue. */
export type FailedPayoutRow = {
  payoutId: string;
  workerId: string;
  workerName: string;
  amountPaise: number;
  attempt: number;
  failureCode: string | null;
  failureReason: string | null;
  failedAt: string | null;
  batchPayAt: string | null;
};

/** The escrow balance spec §7 puts at the top of the payouts module, read from
 *  the ledger rather than from any column. */
export type FinanceSnapshot = {
  escrowPaise: number;
  workerPayablePaise: number;
  platformRevenuePaise: number;
  taxPayablePaise: number;
  /** Confirmed and matured but not yet in a batch — what the next run owes. */
  awaitingPayoutPaise: number;
  /** Verified-destination gap: earnings that are ready but whose worker has no
   *  verified `payout_methods` row, which is what `build_payout_batch()` skips. */
  blockedOnKycPaise: number;
};

export type PayoutFormState = {
  status: "idle" | "error";
  error?: string;
  fieldErrors?: Record<string, string>;
};
