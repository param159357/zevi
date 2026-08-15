/**
 * The shapes the dispute queries and actions take and return.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export async
 * functions — the same split `lib/deliveries/types.ts` makes.
 */

import type { Database } from "@/types/database.types";

export type DisputeStatus = Database["public"]["Enums"]["dispute_status"];
export type DisputeOutcome = Database["public"]["Enums"]["dispute_outcome"];
export type PartyRole = Database["public"]["Enums"]["party_role"];

/** Keyed by input name, like every other form in the codebase. */
export type FieldErrors = Record<string, string>;

/** One side's 500 characters. */
export type PartyStatement = {
  id: string;
  authorRole: PartyRole;
  authorName: string;
  body: string;
  /** Whether the viewer wrote it. The screen labels "you" rather than a name,
   *  because a client reading "Priya said" about their own statement is a
   *  moment of confusion in a screen that is already tense. */
  isMine: boolean;
  createdAt: string;
};

/**
 * Everything `/disputes/[disputeId]` renders, for either party.
 *
 * Deliberately *not* what the console's `DisputeCase` carries. A participant
 * sees their own case; they do not see the other side's private history, the
 * raw unredacted chat, or the risk columns — those exist for a reviewer and are
 * gated on `view_disputes` at the table level, not trimmed from a SELECT list
 * here. Two screens, two types, and the narrower one cannot accidentally widen.
 */
export type DisputeView = {
  disputeId: string;
  jobId: string;
  jobTitle: string;
  status: DisputeStatus;
  outcome: DisputeOutcome | null;
  splitClientBps: number | null;
  decisionNote: string | null;
  decidedAt: string | null;
  reasonSummary: string;
  amountPaise: number;
  budgetPaise: number;
  openedAt: string;
  responseDueAt: string;
  decisionDueAt: string;
  raisedByRole: PartyRole;
  /** Which side the viewer is. Decides every piece of copy on the page. */
  viewerRole: "client" | "worker";
  /** True when the viewer raised it. */
  raisedByMe: boolean;
  /** Spec §5's 70% ceiling, when a late cancellation opened this case. Shown to
   *  the client because they were told it when they asked. */
  clientRefundCapBps: number | null;
  statements: PartyStatement[];
  /** The viewer has not filed one yet, and the case is still open. */
  canRespond: boolean;
};

/** Whether a job is currently disputable by the viewer, and why not if not. */
export type DisputeEligibility =
  | { canRaise: true; deadlineNote: string | null }
  | { canRaise: false; reason: string };

// ---------------------------------------------------------------------------
// Action results
// ---------------------------------------------------------------------------

export type OpenDisputeResult =
  | { ok: true; disputeId: string }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

export type RespondResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: FieldErrors };
