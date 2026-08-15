/**
 * The shapes the earnings screen reads. Kept out of the query module for the
 * same reason every other feature here does it — and out of `eligibility.ts`,
 * which stays a pure function of three columns and should not learn about job
 * titles.
 */

import type { EarningStatus } from "@/lib/payouts/eligibility";
import type { Database } from "@/types/database.types";

export type PayoutStatus = Database["public"]["Enums"]["payout_status"];

/** One completed job, as money. Spec §6 wants commission and tax as separate
 *  visible lines, never folded into a total. */
export type EarningLine = {
  id: string;
  jobId: string;
  jobTitle: string;
  status: EarningStatus;
  grossPaise: number;
  commissionPaise: number;
  taxPaise: number;
  netPaise: number;
  acceptedAt: string | null;
  eligibleAt: string | null;
  holdUntil: string | null;
  holdReason: string | null;
  /** Set once a batch has claimed it. */
  payout: {
    id: string;
    status: PayoutStatus;
    paidAt: string | null;
    scheduledPayAt: string | null;
  } | null;
};

/** What the four balances on the screen mean, and why they are four and not one. */
export type EarningTotals = {
  /** Accepted, inside the 48 hours. */
  maturingPaise: number;
  /** Past the 48 hours and clear of any hold — in the next batch. */
  payablePaise: number;
  /** The new client's 14-day chargeback window. */
  heldPaise: number;
  /** Claimed by a batch, not yet disbursed. */
  inPayoutPaise: number;
  /** Under dispute or chargeback investigation. */
  frozenPaise: number;
  paidPaise: number;
};

/** The run the worker is waiting on, and what is riding on it. */
export type NextRun = {
  cutoffAt: string;
  scheduledPayAt: string;
  closesLabel: string;
  paysLabel: string;
  amountPaise: number;
  jobCount: number;
};

export type EarningsOverview = {
  lines: EarningLine[];
  totals: EarningTotals;
  nextRun: NextRun | null;
  /**
   * Whether a verified payout destination exists. False for everyone until KYC
   * is built (spec §6 puts it before the first payout), which is why the screen
   * says so rather than showing a pay date it cannot keep.
   */
  canBePaid: boolean;
};
