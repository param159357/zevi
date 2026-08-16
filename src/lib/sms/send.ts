/**
 * SMS delivery — the seam, in the same position `lib/email/send.ts` holds for
 * email and for the same reasons.
 *
 * There is a provider behind it now: MSG91, in `msg91.ts`. What this file adds
 * is the answer to "and when it is not configured?", which differs by
 * environment and must never be "quietly do nothing":
 *
 *   * **development** prints the code to the server console, so a signup can be
 *     walked end to end without a DLT registration. This is the one place a live
 *     OTP is ever printed.
 *   * **production** throws, so the signup fails loudly on the first attempt.
 *     Spec §5 and §6 both make the mobile step compulsory and `resolveStep()`
 *     will not move past it, so a silent failure here is every user stranded on
 *     one screen with nothing to tell them why.
 *
 * ### There is no message body here
 *
 * India's DLT regime registers the wording with the operators before anything is
 * sent, so what leaves this file is a template id and a set of variables. The
 * text lives on the DLT portal and in `docs/sms-setup.md`; keeping a second copy
 * in TypeScript would be a copy that drifts and that nothing sends. The console
 * print below shows the variables for the same reason — it reports what we
 * actually handed to MSG91, not a guess at what MSG91 rendered.
 */

import { OTP_TTL_SECONDS } from "@/lib/constants/auth";
import { isSmsConfigured, serverEnv } from "@/lib/env";
import { Msg91Error, sendFlow } from "@/lib/sms/msg91";
import { formatMobile } from "@/lib/utils/validation";

/**
 * Extends `Msg91Error` so a caller can ask one question — "is this worth trying
 * again?" — of every way a send can fail. It is not: no amount of waiting
 * configures an environment variable.
 */
export class SmsNotConfiguredError extends Msg91Error {
  constructor() {
    super(
      "MSG91 is not configured. Set MSG91_AUTH_KEY, MSG91_SENDER_ID and " +
        "MSG91_OTP_TEMPLATE_ID, and register the sender and template on DLT " +
        "(see docs/sms-setup.md).",
      { status: 400, retryable: false },
    );
    this.name = "SmsNotConfiguredError";
  }
}

/**
 * The slots the approved template declares.
 *
 * `VALIDITY` is derived from `OTP_TTL_SECONDS` rather than written into the
 * registered text, so the minutes the message promises and the minutes
 * `request_phone_verification()` actually allows cannot come apart. A template
 * registered with a fixed "10 minutes" and only an `##OTP##` slot still works —
 * MSG91 ignores a variable the text has no room for — it just stops tracking the
 * constant.
 */
function verificationVariables(code: string): Record<string, string> {
  return {
    OTP: code,
    VALIDITY: String(Math.round(OTP_TTL_SECONDS / 60)),
  };
}

export async function sendVerificationSms(to: string, code: string): Promise<void> {
  const variables = verificationVariables(code);

  if (!isSmsConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new SmsNotConfiguredError();
    }

    console.info(
      [
        "",
        "──── [sms] not sent (MSG91 is not configured) ────",
        `to:        ${formatMobile(to)}`,
        ...Object.entries(variables).map(([name, value]) => `${`${name}:`.padEnd(10)} ${value}`),
        "──────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );

    return;
  }

  const requestId = await sendFlow({
    templateId: serverEnv.msg91OtpTemplateId,
    mobile: to,
    variables,
  });

  // The handle a delivery report is looked up by, and the only record that this
  // attempt happened at all — there is no outbox behind SMS. Deliberately
  // without the code in it: this line runs in production.
  console.info(
    `[sms] verification code sent to ${formatMobile(to)} (msg91 ${requestId || "no request id"})`,
  );
}
