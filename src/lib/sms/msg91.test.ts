import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Msg91Error, sendFlow, toMsg91Mobile } from "@/lib/sms/msg91";

/**
 * The MSG91 wrapper, and one case in particular.
 *
 * Most of what this module does is unremarkable, but it exists to close a trap
 * that no amount of care at the call site would: **MSG91 answers a refusal with
 * HTTP 200**, carrying `{"type": "error"}` in the body. An insufficient balance,
 * an archived template and a blacklisted sender id all arrive that way. Code
 * that trusts the status reports each of them as a code delivered, and the user
 * waits on a message that was never sent — with the resend cooldown already
 * running, because `request_phone_verification()` commits before anything is
 * sent.
 *
 * So the assertions below are about the shape of the request we make and the
 * reading of the answer we get. `fetch` is stubbed, which is a different thing
 * from mocking a dependency's behaviour to test our use of it: the responses
 * here are transcriptions of what MSG91's documentation says it returns, and
 * what is under test is our parsing of them.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.MSG91_AUTH_KEY = "test-auth-key";
  process.env.MSG91_SENDER_ID = "ZEVIIN";
  process.env.MSG91_OTP_TEMPLATE_ID = "651a1f2b3c4d5e6f7a8b9c0d";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

/** Stub `fetch` with one canned answer, and keep the request for inspection. */
function stubFetch(response: { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  return calls;
}

const OTP_SEND = {
  templateId: "651a1f2b3c4d5e6f7a8b9c0d",
  mobile: "+919876543210",
  variables: { OTP: "123456", VALIDITY: "10" },
};

describe("toMsg91Mobile", () => {
  it("drops the plus and keeps the country code", () => {
    // This is the whole conversion, and the reason it is a named function: a `+`
    // reaching MSG91 is not an error there, it is a message that never arrives.
    expect(toMsg91Mobile("+919876543210")).toBe("919876543210");
  });

  it.each([
    // The two that matter, and they are the same mistake from either side: a
    // subscriber number that lost its country code upstream. MSG91 accepts both
    // and delivers neither, so refusing here is the only place it shows.
    ["a ten-digit number with no country code", "9876543210"],
    ["an E.164-looking number that is only a subscriber number", "+9876543210"],
    ["a number with the country code but no plus", "919876543210"],
    ["a formatted number", "+91 98765 43210"],
    ["something that is not a number at all", "not-a-number"],
    ["an empty string", ""],
  ])("refuses %s", (_label, input) => {
    expect(() => toMsg91Mobile(input)).toThrow(Msg91Error);
  });

  it("refuses without blaming the network", () => {
    // Our own refusal before a request was made — retrying it is pointless, and
    // the caller decides what to say to the user from exactly this flag.
    try {
      toMsg91Mobile("nonsense");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Msg91Error);
      expect((error as Msg91Error).retryable).toBe(false);
    }
  });
});

describe("sendFlow", () => {
  it("posts the template, the registered sender and the variables", async () => {
    const calls = stubFetch({ body: { message: "3554736c4f8d2865fc8b4567", type: "success" } });

    await sendFlow(OTP_SEND);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://control.msg91.com/api/v5/flow");
    expect(calls[0].init.method).toBe("POST");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authkey).toBe("test-auth-key");

    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      template_id: "651a1f2b3c4d5e6f7a8b9c0d",
      sender: "ZEVIIN",
      // No links in a verification code, so no link rewriting. Asserted because
      // it is a decision, not a default we happen to be getting.
      short_url: "0",
      // The variables are flattened alongside `mobiles`, not nested under it —
      // MSG91 reads every other key on the recipient as a template slot.
      recipients: [{ mobiles: "919876543210", OTP: "123456", VALIDITY: "10" }],
    });
  });

  it("returns the request id, which is how a delivery report is found", async () => {
    stubFetch({ body: { message: "3554736c4f8d2865fc8b4567", type: "success" } });

    await expect(sendFlow(OTP_SEND)).resolves.toBe("3554736c4f8d2865fc8b4567");
  });

  it("does not fail a send that went out without a request id", async () => {
    // Unlike SES's MessageId, this id is a convenience for reading a dashboard,
    // not the handle a later event is matched by. Throwing over a missing one
    // would fail a message already on its way and leave the user in a resend
    // cooldown holding a code nothing told them was valid.
    stubFetch({ body: { type: "success" } });

    await expect(sendFlow(OTP_SEND)).resolves.toBe("");
  });

  it("treats a 200 carrying type:error as the refusal it is", async () => {
    // The case this module exists for.
    stubFetch({ status: 200, body: { message: "Insufficient balance", type: "error" } });

    await expect(sendFlow(OTP_SEND)).rejects.toThrow(/Insufficient balance/);
  });

  it("does not invite a retry of a considered refusal", async () => {
    stubFetch({ status: 200, body: { message: "Template not approved", type: "error" } });

    await expect(sendFlow(OTP_SEND)).rejects.toMatchObject({ retryable: false });
  });

  it("reports a refusal with no reason on it rather than reading it as success", async () => {
    stubFetch({ status: 200, body: { type: "error" } });

    await expect(sendFlow(OTP_SEND)).rejects.toThrow(/no reason given/);
  });

  it("reads a rejected body's per-field complaints", async () => {
    // A 400 puts an object where the sentence usually is. It is logged, never
    // shown, so JSON is the right amount of effort — but it must not come out
    // as "[object Object]".
    stubFetch({
      status: 400,
      body: { message: { template_id: ["The template id is invalid."] }, type: "error" },
    });

    await expect(sendFlow(OTP_SEND)).rejects.toThrow(/The template id is invalid/);
  });

  it("counts a rate limit as worth trying again", async () => {
    stubFetch({ status: 429, body: { message: "Too many requests", type: "error" } });

    await expect(sendFlow(OTP_SEND)).rejects.toMatchObject({ retryable: true, status: 429 });
  });

  it("counts MSG91 having a moment as worth trying again", async () => {
    stubFetch({ status: 503, body: { message: "Service unavailable", type: "error" } });

    await expect(sendFlow(OTP_SEND)).rejects.toMatchObject({ retryable: true });
  });

  it("counts an unreachable MSG91 as no answer rather than a negative one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(sendFlow(OTP_SEND)).rejects.toMatchObject({ status: 0, retryable: true });
  });
});
