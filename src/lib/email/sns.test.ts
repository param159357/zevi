import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type SnsEnvelope,
  parseSnsEnvelope,
  snsStringToSign,
  verifySnsMessage,
} from "@/lib/email/sns";

/**
 * The SNS signature check, against a real RSA key pair.
 *
 * Same principle as `sigv4.test.ts` and `commission.test.ts`: a test that
 * derives its expectation the way the code does proves only that the code
 * agrees with itself. So nothing here asserts on a signature this codebase
 * produced. The key pair is generated, the canonical string is signed with
 * Node's signer, and the verifier is asked whether it accepts it — which is
 * exactly the question Amazon's certificate will be asked in production.
 *
 * The half that cannot be tested this way is the *canonical string itself*: if
 * both the signing here and the verifying there build it wrongly in the same
 * way, every test passes and every real message fails. That is why
 * `snsStringToSign` is exported and asserted against literal bytes below,
 * field by field, in the order AWS documents. Those assertions are the ones
 * that would catch a wrong field order; the crypto ones are what prove the
 * signature check is real.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/**
 * The public key, standing in for Amazon's certificate.
 *
 * `crypto.createVerify().verify()` accepts either — a certificate is a wrapper
 * around a public key and Node reaches through it — so injecting the key
 * exercises the same code path a `.pem` from `sns.<region>.amazonaws.com` will,
 * without needing to mint an X.509 certificate to test a signature check.
 */
const CERTIFICATE = publicKey.export({ type: "spki", format: "pem" }).toString();

const CERT_URL = "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc123.pem";
const TOPIC_ARN = "arn:aws:sns:ap-south-1:123456789012:zevi-email-feedback";

const loadCertificate = async () => CERTIFICATE;

/** Sign the canonical form of an envelope the way SNS does. */
function sign(envelope: SnsEnvelope, algorithm: "RSA-SHA1" | "RSA-SHA256"): string {
  return createSign(algorithm).update(snsStringToSign(envelope), "utf8").sign(privateKey, "base64");
}

function notification(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  const envelope: SnsEnvelope = {
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC_ARN,
    Message: '{"notificationType":"Bounce"}',
    Timestamp: "2026-08-16T10:00:00.000Z",
    SignatureVersion: "1",
    Signature: "",
    SigningCertURL: CERT_URL,
    ...overrides,
  };

  return { ...envelope, Signature: sign(envelope, "RSA-SHA1") };
}

describe("snsStringToSign", () => {
  it("builds a notification's canonical form, field name and value on their own lines", () => {
    const envelope = notification();

    expect(snsStringToSign(envelope)).toBe(
      "Message\n" +
        '{"notificationType":"Bounce"}\n' +
        "MessageId\n" +
        "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324\n" +
        "Timestamp\n" +
        "2026-08-16T10:00:00.000Z\n" +
        "TopicArn\n" +
        TOPIC_ARN +
        "\n" +
        "Type\n" +
        "Notification\n",
    );
  });

  it("includes Subject when it is present, in its alphabetical place", () => {
    const envelope = notification({ Subject: "Amazon SES Email Event Notification" });

    // Between MessageId and Timestamp — not appended at the end, which is the
    // shape a naive "add it if we have it" produces and which fails against
    // every real message that carries one.
    expect(snsStringToSign(envelope)).toBe(
      "Message\n" +
        '{"notificationType":"Bounce"}\n' +
        "MessageId\n" +
        "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324\n" +
        "Subject\n" +
        "Amazon SES Email Event Notification\n" +
        "Timestamp\n" +
        "2026-08-16T10:00:00.000Z\n" +
        "TopicArn\n" +
        TOPIC_ARN +
        "\n" +
        "Type\n" +
        "Notification\n",
    );
  });

  it("signs SubscribeURL and Token on a subscription confirmation, and never Subject", () => {
    const envelope: SnsEnvelope = {
      Type: "SubscriptionConfirmation",
      MessageId: "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
      TopicArn: TOPIC_ARN,
      Message: "You have chosen to subscribe to the topic.",
      Timestamp: "2026-08-16T10:00:00.000Z",
      SignatureVersion: "1",
      Signature: "",
      SigningCertURL: CERT_URL,
      Token: "2336412f37…",
      SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription",
      // Present on the envelope and deliberately not signed: a confirmation's
      // signed field list has no Subject in it.
      Subject: "ignored",
    };

    const canonical = snsStringToSign(envelope);

    expect(canonical).toContain("SubscribeURL\n");
    expect(canonical).toContain("Token\n2336412f37…\n");
    expect(canonical).not.toContain("Subject");
  });
});

describe("verifySnsMessage", () => {
  it("accepts a SignatureVersion 1 message signed with SHA-1", async () => {
    await expect(verifySnsMessage(notification(), { loadCertificate })).resolves.toBe(true);
  });

  it("accepts a SignatureVersion 2 message signed with SHA-256", async () => {
    const base: SnsEnvelope = { ...notification(), SignatureVersion: "2", Signature: "" };
    const envelope = { ...base, Signature: sign(base, "RSA-SHA256") };

    await expect(verifySnsMessage(envelope, { loadCertificate })).resolves.toBe(true);
  });

  it("rejects a SignatureVersion 2 message that was signed with SHA-1", async () => {
    // The same bytes, the same key, the wrong digest. This is what a verifier
    // that ignores SignatureVersion and always uses SHA-1 would wave through.
    const base: SnsEnvelope = { ...notification(), SignatureVersion: "2", Signature: "" };
    const envelope = { ...base, Signature: sign(base, "RSA-SHA1") };

    await expect(verifySnsMessage(envelope, { loadCertificate })).resolves.toBe(false);
  });

  it("rejects a message whose body was edited after signing", async () => {
    const envelope = notification();
    const tampered = { ...envelope, Message: '{"notificationType":"Complaint"}' };

    await expect(verifySnsMessage(tampered, { loadCertificate })).resolves.toBe(false);
  });

  it("rejects a message whose topic was edited after signing", async () => {
    const envelope = notification();
    const tampered = { ...envelope, TopicArn: "arn:aws:sns:ap-south-1:999999999999:someone-else" };

    await expect(verifySnsMessage(tampered, { loadCertificate })).resolves.toBe(false);
  });

  it("rejects a Subject added after signing", async () => {
    // Signed without one, delivered with one. The canonical string changes, so
    // the signature must stop matching — which only happens if Subject is part
    // of what is signed rather than something the verifier skips.
    const envelope = notification();
    const tampered = { ...envelope, Subject: "Amazon SES Email Event Notification" };

    await expect(verifySnsMessage(tampered, { loadCertificate })).resolves.toBe(false);
  });

  it("rejects a signature that is not valid base64 rather than throwing", async () => {
    const envelope = { ...notification(), Signature: "not a signature" };

    await expect(verifySnsMessage(envelope, { loadCertificate })).resolves.toBe(false);
  });

  it("refuses a SignatureVersion it has not been told about", async () => {
    const envelope = { ...notification(), SignatureVersion: "3" };

    await expect(verifySnsMessage(envelope, { loadCertificate })).rejects.toThrow(
      /unknown SNS SignatureVersion/,
    );
  });
});

describe("verifySnsMessage — where the certificate may come from", () => {
  /**
   * The URL check is the security boundary: an attacker who can choose it can
   * serve a certificate matching a signature they made themselves. So each case
   * below asserts the fetcher was never *reached*, not merely that the result
   * was false — a verifier that fetches first and validates second has already
   * made the request by the time it says no.
   */
  function fetcherThatMustNotRun() {
    let called = false;
    return {
      wasCalled: () => called,
      load: async () => {
        called = true;
        return CERTIFICATE;
      },
    };
  }

  const rejected = [
    ["plain HTTP", "http://sns.ap-south-1.amazonaws.com/cert.pem"],
    ["a lookalike suffix", "https://sns.ap-south-1.amazonaws.com.attacker.example/cert.pem"],
    ["a lookalike prefix", "https://notsns.ap-south-1.amazonaws.com/cert.pem"],
    ["an unrelated host", "https://attacker.example/cert.pem"],
    ["a non-certificate path", "https://sns.ap-south-1.amazonaws.com/cert.txt"],
    ["nonsense", "not-a-url"],
  ] as const;

  for (const [label, url] of rejected) {
    it(`refuses ${label} without fetching it`, async () => {
      const fetcher = fetcherThatMustNotRun();
      const envelope = { ...notification(), SigningCertURL: url };

      await expect(
        verifySnsMessage(envelope, { loadCertificate: fetcher.load }),
      ).rejects.toThrow(/signing certificate URL/);

      expect(fetcher.wasCalled()).toBe(false);
    });
  }
});

describe("parseSnsEnvelope", () => {
  it("reads a well-formed notification", () => {
    const parsed = parseSnsEnvelope(JSON.parse(JSON.stringify(notification())));

    expect(parsed?.Type).toBe("Notification");
    expect(parsed?.TopicArn).toBe(TOPIC_ARN);
  });

  it("defaults a missing SignatureVersion to 1", () => {
    const { SignatureVersion: _omitted, ...withoutVersion } = notification();

    expect(parseSnsEnvelope(withoutVersion)?.SignatureVersion).toBe("1");
  });

  it("refuses a body that is not an SNS message", () => {
    expect(parseSnsEnvelope(null)).toBeNull();
    expect(parseSnsEnvelope("Notification")).toBeNull();
    expect(parseSnsEnvelope({ Type: "SomethingElse" })).toBeNull();
    expect(parseSnsEnvelope({ notificationType: "Bounce" })).toBeNull();
  });

  it("refuses a message missing any signed field", () => {
    for (const field of ["MessageId", "TopicArn", "Message", "Timestamp", "Signature", "SigningCertURL"]) {
      const envelope: Record<string, unknown> = { ...notification() };
      delete envelope[field];

      expect(parseSnsEnvelope(envelope)).toBeNull();
    }
  });

  it("refuses a confirmation with no token, which nothing could be done with", () => {
    const envelope: Record<string, unknown> = {
      ...notification(),
      Type: "SubscriptionConfirmation",
      SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription",
    };

    expect(parseSnsEnvelope(envelope)).toBeNull();
  });
});
