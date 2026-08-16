import { describe, expect, it } from "vitest";

import { signRequest } from "@/lib/email/sigv4";

/**
 * AWS's own Signature Version 4 test vectors.
 *
 * The point of testing a signer against published vectors rather than against
 * a second implementation of the same algorithm is the point `commission.test.ts`
 * makes about hardcoding the slabs: a test that derives its expectation the way
 * the code does proves only that the code agrees with itself. These signatures
 * were computed by Amazon, with the credentials Amazon publishes for the
 * purpose, and they are what the real endpoint will check against.
 *
 * The credentials below are AWS's documented examples — `AKIDEXAMPLE` and its
 * secret appear verbatim in the Signature Version 4 documentation and authorise
 * nothing.
 */

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

/** 2015-08-30T12:36:00Z — the instant every vector in the suite is signed at. */
const SIGNING_TIME = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

function signatureOf(request: { headers: Record<string, string> }): string {
  const match = /Signature=([0-9a-f]{64})$/.exec(request.headers.authorization);
  if (!match) throw new Error(`no signature in ${request.headers.authorization}`);
  return match[1];
}

describe("signRequest — the aws-sig-v4-test-suite vectors", () => {
  it("signs get-vanilla", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      body: "",
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      now: SIGNING_TIME,
    });

    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 " +
        "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("signs post-vanilla", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      body: "",
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      now: SIGNING_TIME,
    });

    expect(signatureOf(signed)).toBe(
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });

  /**
   * The one vector with a body, which is what SES sends. A signer that hashed
   * the empty string regardless would pass both of the vectors above.
   */
  it("signs post-x-www-form-urlencoded, where the payload hash matters", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      body: "Param1=value1",
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      now: SIGNING_TIME,
    });

    expect(signed.headers.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-date",
    );
    expect(signatureOf(signed)).toBe(
      "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
  });

  /**
   * The worked example in the Signature Version 4 documentation itself: a real
   * IAM `ListUsers` call, with a query string and a second signed header. It
   * covers the two things the suite's vanilla cases do not — canonical query
   * ordering, and headers beyond the two this signer adds itself.
   */
  it("signs the documented IAM ListUsers example", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      region: "us-east-1",
      service: "iam",
      body: "",
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      now: SIGNING_TIME,
    });

    expect(signatureOf(signed)).toBe(
      "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("signRequest — the parts SES depends on", () => {
  const base = {
    method: "POST" as const,
    url: "https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails",
    region: "ap-south-1",
    service: "ses",
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    now: SIGNING_TIME,
  };

  it("signs the body, so a tampered payload no longer verifies", () => {
    const one = signRequest({ ...base, body: '{"to":"a@example.com"}' });
    const two = signRequest({ ...base, body: '{"to":"b@example.com"}' });

    expect(signatureOf(one)).not.toBe(signatureOf(two));
  });

  it("puts the signing date in the credential scope, so yesterday's key is not today's", () => {
    const tomorrow = signRequest({
      ...base,
      body: "{}",
      now: new Date(Date.UTC(2015, 7, 31, 12, 36, 0)),
    });

    expect(tomorrow.headers.authorization).toContain(
      "Credential=AKIDEXAMPLE/20150831/ap-south-1/ses/aws4_request",
    );
    expect(tomorrow.headers["x-amz-date"]).toBe("20150831T123600Z");
  });

  it("refuses a path it would have to double-encode rather than signing it wrong", () => {
    expect(() =>
      signRequest({
        ...base,
        url: "https://email.ap-south-1.amazonaws.com/v2/email/identities/no reply@zevi.in",
        body: "",
      }),
    ).toThrow(/URI encoding/);
  });
});
