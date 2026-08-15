/**
 * Delivery form parsing. Pure, no I/O.
 *
 * Same contract as `lib/matching/validation.ts`: every rule here has a CHECK or
 * a `raise` behind it. These parsers turn a constraint violation into a
 * sentence someone can act on; they never stand in for one.
 */

import {
  DELIVERY_NOTE_MAX_LENGTH,
  REVISION_REASON_MAX_LENGTH,
  REVISION_REASON_MIN_LENGTH,
} from "@/lib/constants/deliveries";
import type { FieldErrors } from "@/lib/deliveries/types";

/** Control characters out, runs of whitespace collapsed, ends trimmed. Line
 *  breaks survive — a revision request is a list as often as a sentence. */
function clean(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
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
 * Optional. A worker who sends five files and no covering note has still
 * delivered — the files are the work, and an empty string is stored as null so
 * the UI has one thing to check rather than two.
 */
export function parseDeliveryNote(input: string): ParseResult<string | null> {
  const value = clean(input.replace(/\p{Cc}/gu, (character) => (character === "\n" ? "\n" : "")));

  if (value.length > DELIVERY_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      fieldErrors: { note: `Keep it under ${DELIVERY_NOTE_MAX_LENGTH} characters.` },
    };
  }

  return { ok: true, value: value.length > 0 ? value : null };
}

/**
 * Required, and with a floor under it. Spec §5 gives one free revision, and a
 * worker who is being asked to redo work is owed the reason in writing — "no"
 * is not a brief, and the 10-character CHECK on `job_revisions.reason` is the
 * schema saying so.
 */
export function parseRevisionReason(input: string): ParseResult<string> {
  const value = clean(input.replace(/\p{Cc}/gu, (character) => (character === "\n" ? "\n" : "")));

  if (value.length < REVISION_REASON_MIN_LENGTH) {
    return {
      ok: false,
      fieldErrors: {
        reason: "Say what needs changing — the worker only gets one go at this.",
      },
    };
  }

  if (value.length > REVISION_REASON_MAX_LENGTH) {
    return {
      ok: false,
      fieldErrors: { reason: `Keep it under ${REVISION_REASON_MAX_LENGTH} characters.` },
    };
  }

  return { ok: true, value };
}
