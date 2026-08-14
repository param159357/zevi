/**
 * The shape every auth Server Action returns to `useActionState`.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */

export type FormStatus = "idle" | "error" | "sent" | "done";

export type FormState = {
  status: FormStatus;
  /** Something the whole form needs to say. */
  error?: string;
  /** Keyed by input name. */
  fieldErrors?: Record<string, string>;
  notice?: string;
  /** Mobile verification: the number the code went to, and the resend gate. */
  mobile?: string;
  retryAfterSeconds?: number;
};

export const IDLE_FORM_STATE: FormState = { status: "idle" };
