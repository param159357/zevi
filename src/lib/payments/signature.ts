/**
 * The two signatures Razorpay asks us to check, and nothing else.
 *
 * Both are HMAC-SHA256 hex digests, and both answer the same question: did this
 * message really come from Razorpay, or from someone who would like a job
 * assigned without paying for it? They differ in what is signed and with which
 * secret:
 *
 *   * **Checkout** — `order_id|payment_id`, signed with the API key secret.
 *     Handed to the browser when a payment succeeds, so it arrives through the
 *     user's own machine and is worth exactly as much as this check makes it.
 *   * **Webhook** — the raw request body, signed with the webhook secret, which
 *     is a *different* secret set on the endpoint in the dashboard.
 *
 * Kept pure and free of I/O deliberately: this is the boundary where money
 * becomes real, and it should be testable without a network, a database or a
 * Razorpay account.
 *
 * Comparison is constant-time. The timing signal from `===` on a hex digest is
 * small and awkward to exploit, and writing the comparison correctly costs one
 * function — there is no version of this worth being clever about.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for two hex digests.
 *
 * Length is compared first and non-constant-time, which leaks only the length
 * of a value whose length is fixed and public. A malformed signature — wrong
 * length, not hex — is a mismatch, not an exception: this is called on attacker
 * -supplied input and must return false rather than throw.
 */
function digestsMatch(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  if (expected.length !== received.length) return false;

  const expectedBytes = Buffer.from(expected, "hex");
  const receivedBytes = Buffer.from(received, "hex");

  // `Buffer.from(…, "hex")` stops at the first non-hex character rather than
  // throwing, so a garbage signature can produce a short buffer that would make
  // timingSafeEqual throw. Length equality on the *bytes* closes that.
  if (expectedBytes.length !== receivedBytes.length) return false;
  if (expectedBytes.length === 0) return false;

  return timingSafeEqual(expectedBytes, receivedBytes);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * The signature Razorpay Checkout hands the browser on success.
 *
 * Verifying it proves that this payment id belongs to this order and that
 * Razorpay said so. It does *not* prove the payment was captured, or that it was
 * for the right amount — both of those are read back from the API server-side,
 * because the browser is not a source of truth about money even when it is
 * carrying a valid signature.
 */
export function verifyCheckoutSignature({
  orderId,
  paymentId,
  signature,
  keySecret,
}: {
  orderId: string;
  paymentId: string;
  signature: unknown;
  keySecret: string;
}): boolean {
  if (!orderId || !paymentId) return false;

  return digestsMatch(sign(`${orderId}|${paymentId}`, keySecret), signature);
}

/**
 * The `x-razorpay-signature` header on a webhook delivery.
 *
 * `rawBody` must be the bytes as they arrived. Re-serialising parsed JSON
 * changes key order and whitespace and produces a body that will never verify —
 * which is why the route handler reads `request.text()` and parses afterwards.
 */
export function verifyWebhookSignature({
  rawBody,
  signature,
  webhookSecret,
}: {
  rawBody: string;
  signature: unknown;
  webhookSecret: string;
}): boolean {
  return digestsMatch(sign(rawBody, webhookSecret), signature);
}
