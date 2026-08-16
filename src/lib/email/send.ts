/**
 * Email delivery — the seam, in the same position `lib/sms/send.ts` holds for
 * SMS and for the same reasons.
 *
 * Unlike SMS, there *is* a provider behind it: SES, in `ses.ts`. What this file
 * adds is the answer to "and when it is not configured?", which is different in
 * the two environments and must never be "quietly do nothing":
 *
 *   * **development** prints the message to the server console and reports a
 *     `dev-` message id, so a job can be walked end to end — through delivery,
 *     acceptance, a payout — without an AWS account. The id is prefixed rather
 *     than faked into something SES-shaped, so a `provider_message_id` in the
 *     outbox always says truthfully who sent it.
 *   * **production** throws, and throws non-retryably, so the row lands in
 *     `failed` with the reason on it. Spec §15's failure mode is users never
 *     hearing from you; a queue that silently swallows everything is that
 *     failure mode with extra steps.
 */

import { isEmailConfigured } from "@/lib/env";
import { SesError, sendEmail, type SendEmailInput } from "@/lib/email/ses";

export class EmailNotConfiguredError extends SesError {
  constructor() {
    super(
      "SES is not configured. Set SES_REGION, SES_ACCESS_KEY_ID, " +
        "SES_SECRET_ACCESS_KEY and SES_FROM_ADDRESS, and verify the domain " +
        "(see docs/email-setup.md).",
      // Not retryable: no amount of waiting configures an environment variable.
      { status: 400, code: "NotConfigured" },
    );
    this.name = "EmailNotConfiguredError";
  }
}

export async function deliverEmail(input: SendEmailInput): Promise<string> {
  if (!isEmailConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new EmailNotConfiguredError();
    }

    console.info(
      [
        "",
        "──── [email] not sent (SES is not configured) ────",
        `to:      ${input.to}`,
        `subject: ${input.subject}`,
        "",
        input.text,
        "─────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );

    return `dev-${crypto.randomUUID()}`;
  }

  return sendEmail(input);
}
