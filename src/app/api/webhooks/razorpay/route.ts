import { NextResponse } from "next/server";

import { HANDLED_WEBHOOK_EVENTS } from "@/lib/constants/payments";
import { serverEnv } from "@/lib/env";
import { settleCapturedPayment } from "@/lib/payments/settle";
import { verifyWebhookSignature } from "@/lib/payments/signature";
import { createServiceRoleClient } from "@/lib/supabase/server";

/**
 * Razorpay's webhook — the backstop, not the happy path.
 *
 * The client's own confirmation settles almost every payment, because it runs
 * while they are still looking at the screen. This exists for the one that
 * doesn't: a closed tab, a dropped connection, a phone that died between the
 * bank's OTP page and coming back. Without it, that client has been charged and
 * has no worker.
 *
 * Both paths end in the same `settleCapturedPayment`, and settlement is
 * idempotent, so it does not matter which arrives first or whether both do.
 *
 * Configure at Razorpay → Settings → Webhooks, subscribed to `payment.captured`
 * and `payment.failed`, with the secret in `RAZORPAY_WEBHOOK_SECRET`. That
 * secret is *not* the API key secret.
 *
 * ### What is trusted here, and what is not
 *
 * The signature proves the body came from Razorpay. It does not make the body's
 * contents authorisation: the payment row is found by `razorpay_order_id`, and
 * every amount comes from that row and from a fresh read of the Razorpay API.
 * The `notes` we set at order creation are never read back as fact.
 */

/** The signature is over the exact bytes, so nothing may parse before verifying. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type WebhookBody = {
  event?: unknown;
  payload?: {
    payment?: {
      entity?: {
        id?: unknown;
        order_id?: unknown;
        error_description?: unknown;
        error_code?: unknown;
      };
    };
  };
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 200 on anything we have decided not to act on.
 *
 * Razorpay retries a non-2xx for hours. A body we cannot use is not going to
 * become usable on the fourth attempt, and a retry storm against a route that
 * touches money is worse than the event being dropped — which is why every
 * refusal below is logged, and why the ones that *are* worth retrying (a
 * gateway timeout, a database that was briefly down) return 500 instead.
 */
function acknowledge(reason: string): NextResponse {
  return NextResponse.json({ ok: true, reason }, { status: 200 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let webhookSecret: string;
  try {
    webhookSecret = serverEnv.razorpayWebhookSecret;
  } catch {
    // No secret means no way to tell Razorpay from anyone else, and an unsigned
    // "payment captured" is exactly the message an attacker would send.
    console.error("[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET is not set; refusing every delivery.");
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  // Raw bytes, before any parsing. Re-serialised JSON never verifies.
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  if (!verifyWebhookSignature({ rawBody, signature, webhookSecret })) {
    console.error("[razorpay-webhook] rejected a delivery with a bad signature");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return acknowledge("unparseable body");
  }

  const event = asString(body.event);
  if (!event) return acknowledge("no event");

  if (!(HANDLED_WEBHOOK_EVENTS as readonly string[]).includes(event)) {
    // Subscriptions get edited in a dashboard. An event we do not handle is not
    // an error, and a 200 stops Razorpay retrying it forever.
    return acknowledge(`unhandled event ${event}`);
  }

  const entity = body.payload?.payment?.entity;
  const razorpayPaymentId = asString(entity?.id);
  const orderId = asString(entity?.order_id);

  if (!razorpayPaymentId || !orderId) {
    console.error(`[razorpay-webhook] ${event} arrived with no payment or order id`);
    return acknowledge("incomplete payment entity");
  }

  const admin = createServiceRoleClient();

  // The order id is the only thing that ties a webhook to a job, and it is a
  // unique column we wrote ourselves before the client ever saw a payment form.
  const { data: payment, error } = await admin
    .from("payments")
    .select("id, job_id, client_id, status, amount_paise, razorpay_order_id")
    .eq("razorpay_order_id", orderId)
    .maybeSingle();

  if (error) {
    // Worth a retry: this is our database, not their message.
    console.error(`[razorpay-webhook] could not look up order ${orderId}: ${error.message}`);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  if (!payment) {
    // An order raised by a different environment against the same Razorpay
    // account — test keys are shared across deployments more often than not.
    console.error(`[razorpay-webhook] no payment row for order ${orderId}`);
    return acknowledge("unknown order");
  }

  if (event === "payment.failed") {
    const { error: failError } = await admin.rpc("fail_job_payment", {
      p_payment_id: payment.id,
      p_reason:
        asString(entity?.error_description) ?? asString(entity?.error_code) ?? "declined",
    });

    if (failError) {
      console.error(`[razorpay-webhook] could not fail payment ${payment.id}: ${failError.message}`);
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    return acknowledge("payment failed");
  }

  if (payment.status === "captured") {
    return acknowledge("already settled");
  }

  // `actorId` is null: nobody is at a keyboard. Settlement falls back to the
  // payment's own client for the `job.paid` event, which is who paid either way.
  const result = await settleCapturedPayment({
    paymentRowId: payment.id,
    jobId: payment.job_id,
    orderId,
    amountPaise: payment.amount_paise,
    razorpayPaymentId,
    actorId: null,
  });

  if (!result.ok) {
    console.error(`[razorpay-webhook] settle failed for ${payment.id}: ${result.error}`);
    // Retryable means the failure was transient — let Razorpay deliver again.
    // Anything else will fail identically next time, so it is acknowledged and
    // left in the log for a human.
    return result.retryable
      ? NextResponse.json({ ok: false }, { status: 500 })
      : acknowledge("settlement refused");
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
