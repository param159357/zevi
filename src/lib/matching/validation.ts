/**
 * Input parsers for the opt-in boundary.
 *
 * Pure, no I/O. Same contract as the job and auth parsers: every rule here has
 * a matching CHECK on `job_opt_ins` in migration 0007, and this layer exists to
 * turn a constraint violation into a sentence someone can act on — not to
 * replace it.
 *
 * The 300-character total is checked across all three fields at once, because
 * that is how the constraint reads it. Reporting it against the field the
 * worker is most likely to trim would be a guess; the form shows a running
 * budget instead, and this is the backstop.
 */

import {
  NOTICED_MAX_LENGTH,
  NOTICED_MIN_LENGTH,
  OPT_IN_TOTAL_MAX_LENGTH,
  SOFTWARE_MAX_LENGTH,
  SOFTWARE_MIN_LENGTH,
  TURNAROUND_MAX_LENGTH,
  TURNAROUND_MIN_LENGTH,
} from "@/lib/constants/matching";
import type { FieldErrors, OptInFormValues } from "@/lib/matching/types";
import type { Parsed } from "@/lib/utils/validation";

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

/**
 * These three strings are read by a client while they choose who to hire, and
 * by an admin during a dispute. Control characters come out and runs of
 * whitespace collapse before length is judged — otherwise 300 characters of
 * newline passes a constraint that exists to keep the answers short.
 */
function normalise(input: unknown): string {
  return typeof input === "string"
    ? input.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim()
    : "";
}

export function parseSoftware(input: unknown): Parsed<string> {
  const value = normalise(input);

  if (!value) return fail("Say what you'll work in.");
  if (value.length < SOFTWARE_MIN_LENGTH) return fail("Name the software.");
  if (value.length > SOFTWARE_MAX_LENGTH) {
    return fail(`Keep it under ${SOFTWARE_MAX_LENGTH} characters.`);
  }

  return ok(value);
}

export function parseTurnaround(input: unknown): Parsed<string> {
  const value = normalise(input);

  if (!value) return fail("Say how long you'd need.");
  if (value.length < TURNAROUND_MIN_LENGTH) return fail("Give a real turnaround.");
  if (value.length > TURNAROUND_MAX_LENGTH) {
    return fail(`Keep it under ${TURNAROUND_MAX_LENGTH} characters.`);
  }

  return ok(value);
}

/**
 * Spec §6: the anti-AI-slop defence. Nothing here can prove an answer is
 * specific to the brief — only a person reading it can. The floor is the part
 * a parser can hold: an answer too short to contain an observation.
 */
export function parseNoticed(input: unknown): Parsed<string> {
  const value = normalise(input);

  if (!value) return fail("Point at something in the brief.");
  if (value.length < NOTICED_MIN_LENGTH) {
    return fail("Say something specific about this brief — a line, not a word.");
  }
  if (value.length > NOTICED_MAX_LENGTH) {
    return fail(`Keep it under ${NOTICED_MAX_LENGTH} characters.`);
  }

  return ok(value);
}

export type ParsedOptIn = {
  software: string;
  turnaround: string;
  noticed: string;
};

/** All three fields and the shared budget, in one pass, so the form can show
 *  every problem at once rather than one per round trip. */
export function parseOptInFields(
  input: OptInFormValues,
): { ok: true; value: ParsedOptIn } | { ok: false; fieldErrors: FieldErrors } {
  const software = parseSoftware(input.software);
  const turnaround = parseTurnaround(input.turnaround);
  const noticed = parseNoticed(input.noticed);

  const fieldErrors: FieldErrors = {};
  if (!software.ok) fieldErrors.software = software.error;
  if (!turnaround.ok) fieldErrors.turnaround = turnaround.error;
  if (!noticed.ok) fieldErrors.noticed = noticed.error;

  if (!software.ok || !turnaround.ok || !noticed.ok) return { ok: false, fieldErrors };

  const total = software.value.length + turnaround.value.length + noticed.value.length;

  if (total > OPT_IN_TOTAL_MAX_LENGTH) {
    // Named against the longest field, which is the one with room to give.
    const longest = [
      { name: "noticed", length: noticed.value.length },
      { name: "turnaround", length: turnaround.value.length },
      { name: "software", length: software.value.length },
    ].sort((a, b) => b.length - a.length)[0].name;

    return {
      ok: false,
      fieldErrors: {
        [longest]: `That's ${total - OPT_IN_TOTAL_MAX_LENGTH} characters over the ${OPT_IN_TOTAL_MAX_LENGTH} you get across all three.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      software: software.value,
      turnaround: turnaround.value,
      noticed: noticed.value,
    },
  };
}

/** What the form's running counter measures, and what the total is judged on. */
export function optInLength(values: OptInFormValues): number {
  return (
    normalise(values.software).length +
    normalise(values.turnaround).length +
    normalise(values.noticed).length
  );
}
