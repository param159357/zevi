import { NextResponse } from "next/server";

import { parseSesFeedback, recordEmailFeedback } from "@/lib/email/feedback";
import {
  SnsVerificationError,
  confirmSnsSubscription,
  parseSnsEnvelope,
  verifySnsMessage,
} from "@/lib/email/sns";
import { serverEnv } from "@/lib/env";

/**
 * The SNS subscription endpoint — where SES reports a bounce.
 *
 * Spec §15's warning is about mail landing in spam, and the fastest way to get
 * there is to keep sending to addresses that no longer exist. SES suspends an
 * account over a 5% bounce rate or a 0.1% complaint rate, both measured across
 * the whole account, so a hundred dead addresses retried politely take down the
 * receipts, the payout notices and the dispute mail with them. This route is
 * what stops that: every bounce and complaint is recorded, the outbox row is
 * moved to `bounced` or `complained`, and an address that has proved
 * unreachable — or has complained — is suppressed.
 *
 * Subscribe the topic to `<origin>/api/webhooks/ses` and set
 * `SES_SNS_TOPIC_ARN`. Setup is `docs/email-setup.md`, and the SES half of it is
 * `node scripts/ses-domain.ts notifications`.
 *
 * ### What is trusted here
 *
 * Two checks, and the second is the one that matters. The **signature** proves
 * Amazon sent the message — but the certificate is a public SNS certificate, so
 * anybody with an AWS account can create a topic, point it at this URL and
 * publish perfectly signed messages claiming every address we hold has
 * complained. The **topic ARN** is what proves it is *our* topic, which is why
 * `SES_SNS_TOPIC_ARN` is required rather than optional: without it there is no
 * way to tell our bounces from a stranger's, and an unsigned "this user
 * complained" is exactly the message an attacker would send.
 *
 * ### Status codes are a retry policy
 *
 * SNS retries a non-2xx for days. So:
 *
 *   * **200** — done, or decided against. A body that is not an SNS message, an
 *     event we do not act on, a duplicate: none becomes actionable on the
 *     fifteenth delivery, and each is logged instead.
 *   * **403** — the check ran and said no. Nothing to retry.
 *   * **500** — *we* failed: the certificate could not be fetched, the database
 *     refused a write. Redelivery is exactly what is wanted, and it is free —
 *     `record_email_feedback()` is idempotent on the SNS envelope id.
 */

/** The signature covers fields inside the body, so nothing may be trusted before it. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 200 on anything we have decided not to act on, so SNS stops asking. */
function acknowledge(reason: string): NextResponse {
  return NextResponse.json({ ok: true, reason }, { status: 200 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let topicArn: string;
  try {
    topicArn = serverEnv.sesSnsTopicArn;
  } catch {
    console.error(
      "[ses-webhook] SES_SNS_TOPIC_ARN is not set; refusing every delivery. " +
        "Without it a signed message from any SNS topic in the world would be " +
        "accepted as our own. See docs/email-setup.md.",
    );
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return acknowledge("unparseable body");
  }

  const envelope = parseSnsEnvelope(body);
  if (!envelope) {
    console.error("[ses-webhook] rejected a delivery that is not an SNS message");
    return acknowledge("not an SNS message");
  }

  // Before the signature, because it is cheap and because it is the check that
  // decides whether this message is anything to do with us. A stranger's topic
  // pointed at this URL is turned away without a certificate being fetched.
  if (envelope.TopicArn !== topicArn) {
    console.error(`[ses-webhook] rejected a message from an unexpected topic: ${envelope.TopicArn}`);
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  let verified: boolean;
  try {
    verified = await verifySnsMessage(envelope);
  } catch (cause) {
    const reason = cause instanceof SnsVerificationError ? cause.message : "unknown error";
    // "We could not check", not "the check failed". SNS should try again.
    console.error(`[ses-webhook] could not verify ${envelope.MessageId}: ${reason}`);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  if (!verified) {
    console.error(`[ses-webhook] rejected ${envelope.MessageId}: bad signature`);
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  if (envelope.Type === "SubscriptionConfirmation") {
    if (!envelope.SubscribeURL) {
      return acknowledge("subscription confirmation with no URL");
    }

    try {
      await confirmSnsSubscription(envelope.SubscribeURL);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "unknown error";
      console.error(`[ses-webhook] could not confirm the subscription: ${reason}`);
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    // Worth a line in the log: this happens once per deployment, and the day
    // bounces stop arriving it is the first thing to check for.
    console.log(`[ses-webhook] confirmed the subscription to ${envelope.TopicArn}`);
    return NextResponse.json({ ok: true, reason: "subscription confirmed" }, { status: 200 });
  }

  if (envelope.Type === "UnsubscribeConfirmation") {
    // Nothing to do, and everything to say. This endpoint no longer receives
    // bounces, which is the specific failure that is invisible until an account
    // is suspended — it does not break anything a user can see.
    console.error(
      `[ses-webhook] this endpoint has been UNSUBSCRIBED from ${envelope.TopicArn}. ` +
        "Bounces and complaints are no longer arriving; re-subscribe it.",
    );
    return acknowledge("unsubscribed");
  }

  let message: unknown;
  try {
    message = JSON.parse(envelope.Message);
  } catch {
    // The envelope was signed and from our topic, so this is a publisher other
    // than SES on the same topic — worth knowing about, not worth retrying.
    console.error(`[ses-webhook] ${envelope.MessageId} carried a body that is not JSON`);
    return acknowledge("message is not JSON");
  }

  const events = parseSesFeedback(message);

  if (events.length === 0) {
    // An event type we do not act on — a send, an open, a click somebody ticked
    // in the configuration set. Not an error, and a 200 stops SNS retrying it.
    return acknowledge("no actionable events");
  }

  const summary = await recordEmailFeedback(envelope.MessageId, events, message);

  if (summary.failed > 0) {
    console.error(
      `[ses-webhook] ${summary.failed} of ${events.length} event(s) in ` +
        `${envelope.MessageId} could not be recorded`,
    );
    // Redelivery is what is wanted and it is free: the events that did land are
    // idempotent on the envelope id and come back as duplicates.
    return NextResponse.json({ ok: false, ...summary }, { status: 500 });
  }

  if (summary.recorded > 0) {
    console.log(
      `[ses-webhook] ${envelope.MessageId}: ${summary.recorded} recorded, ` +
        `${summary.suppressed} suppressed, ${summary.duplicate} already seen`,
    );
  }

  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
