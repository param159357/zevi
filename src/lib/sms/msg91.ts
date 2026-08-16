/**
 * MSG91, the one call this platform makes: send one templated SMS.
 *
 * **Server-only.** Reads `MSG91_AUTH_KEY` through `serverEnv`. Same shape as
 * `lib/email/ses.ts` and `lib/payments/razorpay.ts` — a typed wrapper over the
 * endpoint we actually use, an error class that separates "MSG91 is busy" from
 * "MSG91 says no", and a bounded wait.
 *
 * ### Why the Flow API and not MSG91's OTP API
 *
 * MSG91 sells a dedicated OTP product that generates the code, stores it, and
 * exposes `/otp/verify` to check it. This platform uses none of that, because
 * the code is already ours: `request_phone_verification()` mints it, stores it
 * bcrypt-hashed, and owns the resend cooldown, the hourly cap and the attempt
 * cap; `verify_phone_otp()` is the only writer of `profiles.mobile_verified_at`.
 * Handing the same job to MSG91 would put the answer to "is this code correct"
 * in two places that can disagree, and would move a security decision out of the
 * database that already enforces every limit around it. So MSG91 is asked to do
 * exactly one thing — carry a string to a handset.
 *
 * ### DLT, and why there is no message body in this file
 *
 * Every commercial SMS in India must match a template registered on an
 * operator's DLT portal against a registered entity and header. So the body is
 * not ours to compose at send time: we name a `template_id`, name the `sender`
 * (the registered header), and pass the variables the approved text has slots
 * for. `docs/sms-setup.md` is the runbook for registering both.
 *
 * ### The trap this module exists to close
 *
 * **MSG91 answers a refusal with HTTP 200.** The envelope is
 * `{"type": "success" | "error", "message": …}`, and `type` is the field that
 * decides — `response.ok` is true for an insufficient balance, an archived
 * template and a blacklisted sender id alike. Code that checks only the status
 * reports every one of those as a code delivered, and the user waits for a
 * message that was never sent. Nothing here trusts the status alone.
 */

import { serverEnv } from "@/lib/env";

const FLOW_URL = "https://control.msg91.com/api/v5/flow";

/**
 * Shorter than the 15s the SES and Razorpay wrappers allow themselves, because
 * this one is different in kind: a user is watching a button spin while it runs.
 * There is no outbox behind SMS and nothing retries, so a long hang is a signup
 * that appears to have frozen.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A failed MSG91 call.
 *
 * `retryable` separates "no answer" from "a negative answer". Nothing in this
 * codebase retries an SMS — there is no queue and the caller is a Server Action
 * — so what it actually decides is what the user is told: whether to try again,
 * or that something is wrong at our end. It is on the class rather than at the
 * call site because the distinction is the provider's to make, and because
 * `lib/sms/send.ts` needs the same answer for a provider that is not configured
 * at all.
 */
export class Msg91Error extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; retryable?: boolean }) {
    super(message);
    this.name = "Msg91Error";
    this.status = options.status;
    // 0 is a network failure or a timeout: no answer, not a negative one.
    this.retryable =
      options.retryable ??
      (options.status === 0 || options.status === 429 || options.status >= 500);
  }
}

/**
 * MSG91 wants the country code and no `+`: `919876543210`. This codebase stores
 * E.164 (`parseMobile` normalises everything to `+91…`), so the conversion is a
 * character, and doing it in a named exported function is what lets a test say
 * so out loud. A `+` reaching MSG91 is not an error there — it is a silently
 * undelivered message.
 *
 * **The leading `+` is required, and the floor is eleven digits.** Both refusals
 * catch the same mistake from opposite sides: a bare `9876543210` is a
 * subscriber number that lost its country code somewhere upstream, and MSG91
 * would accept it and deliver nothing. Nothing in this codebase produces one —
 * `parseMobile` is the only source of a stored number and it always emits
 * `+91…` — so seeing one means something is wrong that a silent send would hide.
 * Eleven is below every country code plus subscriber number this platform can
 * reach and above any ten-digit number missing one; the India rule itself stays
 * in `parseMobile`, where it is enforced against a user's typing.
 */
export function toMsg91Mobile(e164: string): string {
  if (!/^\+\d{11,15}$/.test(e164)) {
    throw new Msg91Error(`Refusing to send to "${e164}": not an E.164 number`, {
      status: 0,
      // Our own refusal, before a request was made. The number will not improve.
      retryable: false,
    });
  }

  return e164.slice(1);
}

type FlowResponse = {
  type?: unknown;
  message?: unknown;
};

/**
 * What MSG91 said went wrong, in whatever shape it said it.
 *
 * `message` is usually a sentence, but a rejected body comes back with an object
 * of per-field complaints under the same key. Both are logged rather than shown:
 * this text is written for whoever is reading the server logs, not for someone
 * trying to sign up.
 */
function describeFailure(payload: FlowResponse | null): string | null {
  if (!payload) return null;

  const { message } = payload;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (message && typeof message === "object") return JSON.stringify(message);

  return null;
}

export type Msg91FlowInput = {
  /** The DLT-approved template, by its MSG91 id. */
  templateId: string;
  /** E.164, as stored. Converted here, not by the caller. */
  mobile: string;
  /**
   * The slots in the approved text, by the names it declares them under. MSG91
   * matches on the name and ignores a variable the template has no slot for, so
   * sending one the text does not use is safe; omitting one it does use leaves a
   * literal placeholder in the message.
   */
  variables: Record<string, string>;
};

/**
 * Send one message. Returns MSG91's request id — the handle a delivery report in
 * their dashboard is found by, and the only thing that ties a support question
 * about a missing code to a specific attempt.
 *
 * Unlike SES's `MessageId`, a missing request id is **not** treated as fatal.
 * The two are used for different things: SES's is what a later bounce is matched
 * back to, so a send without one is unaccountable, while this one is a
 * convenience for reading a dashboard. Throwing over it would fail a message
 * that has already gone out and put the user in a resend cooldown holding a code
 * they never learned was valid.
 */
export async function sendFlow({
  templateId,
  mobile,
  variables,
}: Msg91FlowInput): Promise<string> {
  const body = {
    template_id: templateId,
    sender: serverEnv.msg91SenderId,
    // MSG91 can rewrite links in a message into tracked short URLs. There are no
    // links in a verification code, and a shortened one in a message asking for
    // a secret is the exact shape of the phishing it would be teaching people to
    // trust. Off explicitly rather than by account default.
    short_url: "0",
    recipients: [{ mobiles: toMsg91Mobile(mobile), ...variables }],
  };

  let response: Response;

  try {
    response = await fetch(FLOW_URL, {
      method: "POST",
      headers: {
        authkey: serverEnv.msg91AuthKey,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    throw new Msg91Error(`Could not reach MSG91: ${reason}`, { status: 0 });
  }

  const text = await response.text();

  let payload: FlowResponse | null;
  try {
    payload = text ? (JSON.parse(text) as FlowResponse) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Msg91Error(
      `MSG91 refused the send: ${describeFailure(payload) ?? response.statusText}`,
      { status: response.status },
    );
  }

  // The 200-with-a-refusal case. See the note at the top of this file: this is
  // the check, and the status code above is not.
  if (payload?.type !== "success") {
    throw new Msg91Error(
      `MSG91 refused the send: ${describeFailure(payload) ?? "no reason given"}`,
      // A considered "no" — a template that is not approved, an account with no
      // balance, a blacklisted header. Sending it again is the same refusal.
      { status: response.status, retryable: false },
    );
  }

  return typeof payload.message === "string" ? payload.message : "";
}
