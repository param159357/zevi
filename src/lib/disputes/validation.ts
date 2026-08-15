/**
 * Dispute form parsing. Pure, no I/O.
 *
 * Same contract as `lib/deliveries/validation.ts`: every rule here has a CHECK
 * or a `raise` behind it. These parsers turn a constraint violation into a
 * sentence someone can act on; they never stand in for one.
 */

import {
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  STATEMENT_MAX_LENGTH,
  STATEMENT_MIN_LENGTH,
} from "@/lib/constants/disputes";
import type { FieldErrors } from "@/lib/disputes/types";

/** Control characters out, runs of whitespace collapsed, ends trimmed. Line
 *  breaks survive — a statement is a list of grievances as often as a
 *  paragraph. */
function clean(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Cc}/gu, (character) => (character === "\n" ? "\n" : ""))
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: FieldErrors };

/**
 * The one-line summary that heads the console queue. Short enough to scan in a
 * list of forty, long enough to be a sentence rather than a category.
 */
export function parseDisputeReason(input: string): ParseResult<string> {
  const value = clean(input);

  if (value.length < REASON_MIN_LENGTH) {
    return {
      ok: false,
      fieldErrors: {
        reason: `Sum it up in a line — at least ${REASON_MIN_LENGTH} characters. This is what we see first.`,
      },
    };
  }

  if (value.length > REASON_MAX_LENGTH) {
    return {
      ok: false,
      fieldErrors: { reason: `Keep the summary under ${REASON_MAX_LENGTH} characters.` },
    };
  }

  return { ok: true, value };
}

/**
 * Spec §11's 500 characters, required from each side.
 *
 * The ceiling is the point of it: a reviewer has three minutes for the whole
 * case, and a limit that forces someone to say the important thing first is
 * worth more to them than unlimited room. The floor is the schema refusing a
 * statement that is not one.
 */
export function parseStatement(input: string): ParseResult<string> {
  const value = clean(input);

  if (value.length < STATEMENT_MIN_LENGTH) {
    return {
      ok: false,
      fieldErrors: {
        statement: `Tell us what happened — at least ${STATEMENT_MIN_LENGTH} characters. This is what the decision is made from.`,
      },
    };
  }

  if (value.length > STATEMENT_MAX_LENGTH) {
    return {
      ok: false,
      fieldErrors: {
        statement: `${STATEMENT_MAX_LENGTH} characters is the limit. Lead with the part that matters most.`,
      },
    };
  }

  return { ok: true, value };
}

/**
 * The reason a client gives for cancelling.
 *
 * Held to the statement's floor rather than the `cancellations.reason` CHECK's
 * three characters, and for a reason worth stating: a request past half the
 * deadline becomes a dispute, and that reason *is* the client's opening
 * statement. A three-character cancellation reason would be refused by
 * `open_dispute()` one call later, which is a worse place to find out.
 */
export function parseCancellationReason(input: string): ParseResult<string> {
  const value = clean(input);

  if (value.length < STATEMENT_MIN_LENGTH) {
    return {
      ok: false,
      fieldErrors: {
        reason: `Say why, in at least ${STATEMENT_MIN_LENGTH} characters. If more than half the deadline has gone, this is the statement one of us reads.`,
      },
    };
  }

  if (value.length > REASON_MAX_LENGTH) {
    return {
      ok: false,
      fieldErrors: { reason: `Keep it under ${REASON_MAX_LENGTH} characters.` },
    };
  }

  return { ok: true, value };
}
