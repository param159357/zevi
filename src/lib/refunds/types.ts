/** What one run of the refund drain did. Logged by the cron, returned as JSON. */
export type RefundDrainSummary = {
  /** Rows this run took off the queue. */
  claimed: number;
  /** Instructions Razorpay accepted and has not finished: still `processing`. */
  submitted: number;
  /** Money confirmed gone, ledger written, `completed`. */
  completed: number;
  /** Transient trouble; back to `pending` with a later `next_attempt_at`. */
  retrying: number;
  /** Given up on, and sitting in `refunds` for a person. */
  failed: number;
};

/**
 * A refund the gateway has been asked about, as far as the drain cares.
 *
 * Deliberately not Razorpay's vocabulary: `processed` and `pending` are their
 * words for two states that read almost identically, and a switch on them
 * three functions deep is where a "pending" gets treated as a "processed" and a
 * ledger says money left that has not.
 */
export type RefundOutcome = "settled" | "accepted" | "rejected";

/**
 * A refund as the two sides of a job see it.
 *
 * Four fields and no fifth. `razorpay_refund_id` is a gateway handle, `attempts`
 * is our queue's business, and `failure_reason` is a developer's sentence — a
 * client reads what `REFUND_STATUS_COPY` says instead. What is here is what the
 * person owed the money actually needs: how much, why, where it has got to, and
 * when.
 */
export type RefundView = {
  id: string;
  amountPaise: number;
  reason: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
};
