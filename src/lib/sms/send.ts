/**
 * SMS delivery.
 *
 * No provider is wired yet — SMS sits alongside R2, Razorpay, SES and Sentry on
 * the not-yet-integrated list. This module is the seam: when a provider lands,
 * it lands here and nothing above it changes.
 *
 * Until then, development prints the message to the server console so signup
 * can be walked end to end, and production refuses rather than pretending a
 * message was sent. A signup that silently strands every user at the mobile
 * step is worse than one that fails loudly on the first attempt.
 */

import { OTP_TTL_SECONDS } from "@/lib/constants/auth";
import { formatMobile } from "@/lib/utils/validation";

export class SmsNotConfiguredError extends Error {
  constructor() {
    super(
      "No SMS provider is configured. Set one up before running signup in production.",
    );
    this.name = "SmsNotConfiguredError";
  }
}

export function isSmsConfigured(): boolean {
  // Nothing to check yet. The first provider adds its credentials to
  // `serverEnv` and this reads them.
  return false;
}

async function deliver(to: string, body: string): Promise<void> {
  if (!isSmsConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new SmsNotConfiguredError();
    }

    // Development only, and the one place a live OTP is ever printed.
    console.info(`[sms] to ${formatMobile(to)}: ${body}`);
    return;
  }

  throw new SmsNotConfiguredError();
}

export async function sendVerificationSms(to: string, code: string): Promise<void> {
  const minutes = Math.round(OTP_TTL_SECONDS / 60);

  await deliver(
    to,
    `${code} is your Zevi verification code. It expires in ${minutes} minutes. Never share it with anyone.`,
  );
}
