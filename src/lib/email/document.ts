/**
 * What an email is, before it is HTML or text.
 *
 * Spec §15: "Plain, short, one action each, job ID in every subject line." Two
 * of those four are enforced by this shape rather than by remembering them —
 * `action` is one optional field, not a list, so a template cannot grow a second
 * button; and there is no block that takes markup, so nothing can smuggle a
 * layout in. The other two are copy, and copy is checked in `templates.test.ts`.
 *
 * The reason a template returns a document instead of a string is text/HTML
 * parity. Every essential email needs both parts — a message with no
 * `text/plain` alternative is scored down by every spam filter that looks, and
 * spec §15 is a warning about spam — and two hand-written bodies per template
 * drift the first time somebody fixes a sentence in one of them. One structure,
 * two renderers, and a test that reads both.
 */

/** A label/value pair. Money lines are separate rows, never folded (spec §8). */
export type EmailFact = {
  label: string;
  value: string;
  /** For the one row that is the total, or the amount the mail is about. */
  strong?: boolean;
};

export type EmailBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "facts"; rows: EmailFact[] }
  /** Something a person wrote — a revision reason, a rejection note. */
  | { kind: "quote"; text: string }
  /** Small print under the action: what happens if they do nothing. */
  | { kind: "note"; text: string };

export type EmailAction = {
  label: string;
  /** Absolute. Built from `getSiteUrl()`, never a bare path. */
  url: string;
};

export type EmailDocument = {
  /** Carries the job reference wherever the email is about a job (spec §15). */
  subject: string;
  /**
   * The line a mail client shows next to the subject in the list. Left out and
   * the client grabs the first words of the body — which, in a table layout, is
   * whatever markup it finds first.
   */
  preheader: string;
  heading: string;
  blocks: EmailBlock[];
  action?: EmailAction;
  /** One line under the action. Never a second call to action. */
  footnote?: string;
};
