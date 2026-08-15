import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyCheckoutSignature, verifyWebhookSignature } from "@/lib/payments/signature";

/**
 * The signature checks are the only thing standing between "a browser said this
 * payment succeeded" and a job being assigned for free, so the interesting cases
 * are all the negative ones: a good signature for the wrong order, a signature
 * made with a secret that isn't ours, and every shape of garbage that could make
 * a comparison throw instead of returning false.
 */

const KEY_SECRET = "rzp_test_secret_do_not_use";
const WEBHOOK_SECRET = "webhook_secret_do_not_use";

const ORDER_ID = "order_QaBcDeFgHiJkLm";
const PAYMENT_ID = "pay_QaBcDeFgHiJkLm";

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

describe("verifyCheckoutSignature", () => {
  const valid = hmac(`${ORDER_ID}|${PAYMENT_ID}`, KEY_SECRET);

  it("accepts the signature Razorpay computes over order|payment", () => {
    expect(
      verifyCheckoutSignature({
        orderId: ORDER_ID,
        paymentId: PAYMENT_ID,
        signature: valid,
        keySecret: KEY_SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyCheckoutSignature({
        orderId: ORDER_ID,
        paymentId: PAYMENT_ID,
        signature: hmac(`${ORDER_ID}|${PAYMENT_ID}`, "not-our-secret"),
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a valid signature replayed onto another order", () => {
    // The attack this check exists for: pay ₹149 for one job, reuse the proof
    // on a ₹5,000 one.
    expect(
      verifyCheckoutSignature({
        orderId: "order_ZzZzZzZzZzZzZz",
        paymentId: PAYMENT_ID,
        signature: valid,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a valid signature replayed onto another payment", () => {
    expect(
      verifyCheckoutSignature({
        orderId: ORDER_ID,
        paymentId: "pay_ZzZzZzZzZzZzZz",
        signature: valid,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it("is not fooled by the two halves being concatenated differently", () => {
    // `a|b` and `b|a` must not collide, and neither must an unseparated join —
    // the delimiter is load-bearing.
    for (const payload of [
      `${PAYMENT_ID}|${ORDER_ID}`,
      `${ORDER_ID}${PAYMENT_ID}`,
      `${ORDER_ID}|${PAYMENT_ID}|`,
    ]) {
      expect(
        verifyCheckoutSignature({
          orderId: ORDER_ID,
          paymentId: PAYMENT_ID,
          signature: hmac(payload, KEY_SECRET),
          keySecret: KEY_SECRET,
        }),
      ).toBe(false);
    }
  });

  it("refuses missing ids rather than signing an empty pair", () => {
    expect(
      verifyCheckoutSignature({
        orderId: "",
        paymentId: "",
        signature: hmac("|", KEY_SECRET),
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it("returns false — never throws — on anything that isn't a hex digest", () => {
    const junk: unknown[] = [
      undefined,
      null,
      "",
      "not-hex-at-all",
      // Right length, not hex. `Buffer.from(…, "hex")` truncates instead of
      // throwing, which is what would otherwise crash timingSafeEqual.
      "z".repeat(64),
      valid.slice(0, 63),
      `${valid}00`,
      123,
      {},
      [],
      Buffer.from(valid, "hex"),
    ];

    for (const signature of junk) {
      expect(() =>
        verifyCheckoutSignature({
          orderId: ORDER_ID,
          paymentId: PAYMENT_ID,
          signature,
          keySecret: KEY_SECRET,
        }),
      ).not.toThrow();

      expect(
        verifyCheckoutSignature({
          orderId: ORDER_ID,
          paymentId: PAYMENT_ID,
          signature,
          keySecret: KEY_SECRET,
        }),
      ).toBe(false);
    }
  });
});

describe("verifyWebhookSignature", () => {
  const rawBody = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: PAYMENT_ID, order_id: ORDER_ID } } },
  });

  it("accepts a body signed with the webhook secret", () => {
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: hmac(rawBody, WEBHOOK_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a body signed with the API key secret", () => {
    // The two secrets are different values and this is the mistake that makes
    // them look interchangeable in development.
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: hmac(rawBody, KEY_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a body altered after signing, down to one character", () => {
    const signature = hmac(rawBody, WEBHOOK_SECRET);

    for (const tampered of [
      rawBody.replace("captured", "capture "),
      rawBody.replace(PAYMENT_ID, `${PAYMENT_ID.slice(0, -1)}X`),
      `${rawBody} `,
      rawBody.trim().slice(1),
    ]) {
      expect(
        verifyWebhookSignature({ rawBody: tampered, signature, webhookSecret: WEBHOOK_SECRET }),
      ).toBe(false);
    }
  });

  it("rejects a re-serialised body — which is why the route reads raw bytes", () => {
    // JSON.parse then JSON.stringify is lossless here only by luck of key order.
    // Reformatting is not, and this is the failure mode that makes a working
    // webhook stop verifying the day someone adds a body parser.
    const reformatted = JSON.stringify(JSON.parse(rawBody), null, 2);

    expect(reformatted).not.toBe(rawBody);
    expect(
      verifyWebhookSignature({
        rawBody: reformatted,
        signature: hmac(rawBody, WEBHOOK_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(false);
  });

  it("verifies a body with non-ASCII characters byte for byte", () => {
    // Job titles reach the notes, and ₹ is two bytes. Signing over the string
    // and hashing over UTF-8 bytes have to agree.
    const body = JSON.stringify({ notes: { title: "Logo — ₹149 job" } });

    expect(
      verifyWebhookSignature({
        rawBody: body,
        signature: hmac(body, WEBHOOK_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(true);
  });

  it("returns false — never throws — on a missing or malformed header", () => {
    for (const signature of [undefined, null, "", "sha256=abc", 0, {}]) {
      expect(() =>
        verifyWebhookSignature({ rawBody, signature, webhookSecret: WEBHOOK_SECRET }),
      ).not.toThrow();

      expect(
        verifyWebhookSignature({ rawBody, signature, webhookSecret: WEBHOOK_SECRET }),
      ).toBe(false);
    }
  });

  it("treats hex case as cosmetic — the same bytes are the same signature", () => {
    // Razorpay sends lowercase. Uppercase decodes to identical bytes, so it is
    // the same signature and not a near-miss worth rejecting.
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: hmac(rawBody, WEBHOOK_SECRET).toUpperCase(),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(true);
  });

  it("verifies an empty body, leaving the route to reject it on content", () => {
    // A correctly signed empty body is genuinely signed by whoever holds the
    // secret — the signature check has no opinion about it. There is nothing to
    // act on, and it is the route's parse step that says so.
    expect(
      verifyWebhookSignature({
        rawBody: "",
        signature: hmac("", WEBHOOK_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(true);
  });
});
