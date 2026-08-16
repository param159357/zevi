/**
 * Refund constants — spec §14.
 *
 * The same division every other queue in this codebase has with its database
 * rule: the schedule lives here, the invariant lives in the migration. A stale
 * copy of one of these numbers makes the drain politely wrong about *when* to
 * try again; it can never make `mark_refund_failed()` retry past
 * `refund.max_attempts`, or `claim_refund_batch()` hand the same row to two
 * drains.
 */

/**
 * How many refunds one drain works through.
 *
 * Smaller than the email batch, and for a better reason than caution: each row
 * here is one or two signed HTTPS round trips to Razorpay, and the failure mode
 * of going too fast is not a throttled message but a payment API deciding we
 * look like a script. Ten is comfortably more than a day's cancellations at the
 * volume spec §9 plans for, and a backlog past that is drained fifteen minutes
 * later.
 */
export const REFUND_BATCH_SIZE = 10;

/**
 * How many *submissions* one refund gets before it is left `failed` for a
 * human.
 *
 * Mirrors `platform_settings.refund.max_attempts`, which is what actually
 * decides. Polls of an already-submitted refund are not submissions and do not
 * count — once Razorpay holds the instruction the only question left is when it
 * finishes, and "give up" is not one of the answers.
 *
 * Six attempts over the backoff below spans about a day and a half, and rather
 * more in practice because the drain runs every fifteen minutes. That is the
 * right length for the transient class — an acquirer having an afternoon, a
 * 5xx, a rate limit — and short of pestering a gateway that has made up its
 * mind.
 */
export const REFUND_MAX_ATTEMPTS = 6;

/**
 * Backoff before the next submission, in seconds, indexed by submissions
 * already made. Quintupling from two minutes: 2m, 10m, 50m, 4h10m, 20h50m.
 *
 * Steeper than the email backoff on purpose. A late email is a late email; a
 * refund that Razorpay is refusing for a reason that will not change is one
 * where the useful work is a person reading the failure, and the schedule
 * should get out of that person's way rather than filling the log.
 */
export function refundRetryDelaySeconds(attempts: number): number {
  return 120 * 5 ** Math.max(attempts - 1, 0);
}

/**
 * How long a claimed refund is left alone before another drain may take it.
 *
 * Mirrors `platform_settings.refund.claim_stale_minutes`. Longer than any
 * plausible request, so a run that is merely slow is never raced; short enough
 * that a crashed run does not strand a client's money for a day.
 */
export const REFUND_CLAIM_STALE_MINUTES = 15;

/**
 * How long before a submitted refund is asked about again.
 *
 * Mirrors `platform_settings.refund.poll_minutes`. Razorpay usually settles a
 * refund to `processed` within minutes, but the promise made to the client is
 * 5–7 working days, so there is nothing to win by polling harder — and each
 * poll is an API call spent on a question whose answer changes slowly.
 */
export const REFUND_POLL_MINUTES = 30;

/**
 * `refund_reason`, in words a client reads.
 *
 * Spec §14 requires a logged reason on every refund, and the enum is that log.
 * It is not the sentence to put in front of the person getting the money —
 * "dispute_split" in an email is a database column leaking into someone's inbox.
 * Kept here rather than in the email template because the same words belong on
 * the screen that shows the refund, and two copies would drift.
 *
 * A reason with no entry renders as itself rather than as nothing: a value added
 * to the enum and not to this map should look unfinished, not invisible.
 */
export const REFUND_REASON_LABELS: Record<string, string> = {
  client_cancellation: "You cancelled the job",
  worker_abandonment: "The worker did not finish",
  dispute_refund: "A case was decided in your favour",
  dispute_split: "A case was settled part-way",
  prohibited_work: "The job broke the rules",
  job_expired: "Nobody was picked in time",
  admin_adjustment: "An adjustment by Zevi",
  chargeback: "A chargeback on the original payment",
};

export function refundReasonLabel(reason: string): string {
  return REFUND_REASON_LABELS[reason] ?? reason;
}

/**
 * What each `refund_status` means to the client, and how loudly to say it.
 *
 * `pending` and `processing` are honestly the same thing from where a client
 * stands — the money is coming and Zevi is dealing with it — and separating
 * them on the screen would invite the question of which is which. `failed` is
 * the one that has to be said plainly: something went wrong and a person is on
 * it, because the alternative is a client watching a bank account for money
 * that is not on its way.
 */
export const REFUND_STATUS_COPY: Record<
  string,
  { label: string; detail: string; tone: "info" | "success" | "error" }
> = {
  pending: {
    label: "Refund on its way",
    detail: "We're sending it back to the card or account you paid with.",
    tone: "info",
  },
  processing: {
    label: "Refund on its way",
    detail:
      "It's with your bank now and takes 5–7 working days to appear, depending on them.",
    tone: "info",
  },
  completed: {
    label: "Refunded",
    detail:
      "It's gone back to the card or account you paid with. Your bank may take a few days to show it.",
    tone: "success",
  },
  failed: {
    label: "Refund held up",
    detail:
      "Your bank wouldn't take it back automatically. Someone at Zevi is on this — you don't need to do anything.",
    tone: "error",
  },
};
