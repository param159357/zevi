import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OTP_TTL_SECONDS } from "@/lib/constants/auth";
import { SmsNotConfiguredError, sendVerificationSms } from "@/lib/sms/send";

/**
 * The seam, and the three things it decides.
 *
 * `msg91.test.ts` covers the provider. What is left here is the part that has no
 * provider in it: whether an unconfigured environment prints or throws, which
 * variables the approved template is handed, and what the production log line is
 * allowed to contain. The last of those is the reason this file exists — the
 * console print in development is the one place a live OTP is ever written down,
 * and the assertion below is what keeps it that way when somebody later adds a
 * field to the line that runs in production.
 */

const CODE = "417293";
const MOBILE = "+919876543210";

function configure() {
  vi.stubEnv("MSG91_AUTH_KEY", "test-auth-key");
  vi.stubEnv("MSG91_SENDER_ID", "ZEVIIN");
  vi.stubEnv("MSG91_OTP_TEMPLATE_ID", "651a1f2b3c4d5e6f7a8b9c0d");
}

beforeEach(() => {
  // Unconfigured is the default, because that is what a fresh checkout is.
  vi.stubEnv("MSG91_AUTH_KEY", "");
  vi.stubEnv("MSG91_SENDER_ID", "");
  vi.stubEnv("MSG91_OTP_TEMPLATE_ID", "");
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Everything `console.info` was given, joined. */
function logged(): string {
  return vi
    .mocked(console.info)
    .mock.calls.map((call) => call.join(" "))
    .join("\n");
}

describe("when MSG91 is not configured", () => {
  it("prints the code rather than throwing, so a local signup can be walked", async () => {
    await expect(sendVerificationSms(MOBILE, CODE)).resolves.toBeUndefined();

    const output = logged();
    expect(output).toContain("not sent (MSG91 is not configured)");
    expect(output).toContain(CODE);
    // Formatted, not raw: this line is read by a person.
    expect(output).toContain("+91 98765 43210");
  });

  it("throws in production instead of stranding every signup on one screen", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(sendVerificationSms(MOBILE, CODE)).rejects.toThrow(SmsNotConfiguredError);
  });

  it("does not invite a retry of a missing environment variable", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(sendVerificationSms(MOBILE, CODE)).rejects.toMatchObject({ retryable: false });
  });

  it("refuses on a partial configuration, because DLT would too", async () => {
    // The auth key alone authenticates and sends nothing: without the registered
    // header and the approved template the operator drops the message.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MSG91_AUTH_KEY", "test-auth-key");

    await expect(sendVerificationSms(MOBILE, CODE)).rejects.toThrow(SmsNotConfiguredError);
  });
});

describe("when MSG91 is configured", () => {
  function stubFetch(body: unknown = { message: "3554736c4f8d2865fc8b4567", type: "success" }) {
    const calls: RequestInit[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    return calls;
  }

  it("hands the OTP template the two variables it declares", async () => {
    configure();
    const calls = stubFetch();

    await sendVerificationSms(MOBILE, CODE);

    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      template_id: "651a1f2b3c4d5e6f7a8b9c0d",
      recipients: [
        {
          mobiles: "919876543210",
          OTP: CODE,
          // Derived from the constant rather than written into the registered
          // text, so the promise and the limit cannot come apart.
          VALIDITY: String(OTP_TTL_SECONDS / 60),
        },
      ],
    });
  });

  it("never writes the code to a log line that runs in production", async () => {
    configure();
    stubFetch();

    await sendVerificationSms(MOBILE, CODE);

    const output = logged();
    // The request id is the point of the line — it is how a delivery report is
    // found — and the code is what must never be beside it.
    expect(output).toContain("3554736c4f8d2865fc8b4567");
    expect(output).not.toContain(CODE);
  });

  it("still logs an attempt MSG91 gave no request id for", async () => {
    configure();
    stubFetch({ type: "success" });

    await sendVerificationSms(MOBILE, CODE);

    expect(logged()).toContain("no request id");
  });
});
