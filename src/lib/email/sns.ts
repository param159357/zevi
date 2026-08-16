/**
 * Amazon SNS message verification — the envelope every bounce arrives in.
 *
 * **Server-only.** Fetches a certificate over the network and verifies a
 * signature; nothing here belongs in a browser bundle.
 *
 * ### Why this file exists at all
 *
 * SES reports a bounce by publishing to an SNS topic, and SNS delivers to an
 * HTTPS endpoint by POSTing JSON to it. That endpoint is public — it has to be,
 * because Amazon has no credentials of ours to present — so the only thing
 * standing between "a real bounce" and "anyone on the internet who wants a user
 * to stop receiving our email" is the signature on the message.
 *
 * That makes this the same class of code as `lib/payments/signature.ts`, and it
 * is written the same way: no SDK, the algorithm as AWS specifies it, and tests
 * that sign with a real key pair rather than asserting against our own output.
 *
 * ### The two checks, and why neither is enough alone
 *
 *   1. **The signature** proves Amazon sent it. It does not prove *whose*
 *      Amazon: the certificate is a public SNS certificate, so anybody with an
 *      AWS account can create a topic, point it at this URL, and publish
 *      perfectly signed messages saying every address we have has complained.
 *   2. **The topic ARN** is what proves it is ours. It is checked by the route
 *      against `SES_SNS_TOPIC_ARN`, which is why that variable is required
 *      rather than optional and why an unset one refuses every delivery.
 *
 * ### What is deliberately not implemented
 *
 *   * **A freshness window.** A signed SNS message never expires, so the
 *     obvious "reject anything older than an hour" would be a replay defence.
 *     It is not implemented because SNS's own retry policy runs for days: a
 *     bounce our endpoint 500s on today is legitimately redelivered later, and
 *     the window would drop exactly the messages the retry policy exists to
 *     save. Replay is handled where it can be handled without that cost — the
 *     unique `(sns_message_id, recipient)` on `email_events`, which makes a
 *     redelivered message idempotent whether it was replayed by Amazon or by
 *     somebody who kept a copy.
 *   * **Certificate chain validation.** `crypto.createVerify` checks the
 *     signature against the public key in the certificate, not the certificate
 *     against a root. What binds the certificate to Amazon here is the URL it
 *     came from: HTTPS to a host matching `sns.<region>.amazonaws.com`, which
 *     Node's own TLS stack validates against the system trust store before a
 *     byte of it is read.
 */

import { createVerify } from "node:crypto";

/** The three envelope types SNS delivers to an HTTPS subscription. */
export const SNS_MESSAGE_TYPES = [
  "Notification",
  "SubscriptionConfirmation",
  "UnsubscribeConfirmation",
] as const;

export type SnsMessageType = (typeof SNS_MESSAGE_TYPES)[number];

export type SnsEnvelope = {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
};

/**
 * The fields that go into the string to sign, in the order AWS specifies —
 * which is alphabetical, and stays that way because the order is the
 * specification rather than a convenience.
 *
 * `Subject` is optional on a notification and is included only when present.
 * That is the one place a canonical string can differ between two messages of
 * the same type, and getting it wrong fails every notification that happens to
 * carry a subject while passing every one that does not.
 */
const SIGNED_FIELDS: Record<SnsMessageType, readonly (keyof SnsEnvelope)[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

/**
 * Where a signing certificate — and a subscribe URL — may come from.
 *
 * `sns.<region>.amazonaws.com`, or its China partition. Anchored at both ends:
 * an unanchored pattern matches `sns.us-east-1.amazonaws.com.attacker.example`,
 * which is the whole trick this check exists to stop.
 */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** How many certificates one instance keeps. SNS rotates rarely; a handful is plenty. */
const CERTIFICATE_CACHE_LIMIT = 8;
const certificates = new Map<string, string>();

export class SnsVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnsVerificationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read an SNS envelope out of an already-parsed request body.
 *
 * Returns null rather than throwing on anything that is not one: the route
 * answers 200 to a body it cannot use, because a body that is not an SNS
 * message will not become one on the fourth retry.
 *
 * Note what is *not* consulted — the `x-amz-sns-message-type` header. It carries
 * the same word as `Type` and is not covered by the signature, so trusting it
 * would let a caller pick which set of fields gets verified.
 */
export function parseSnsEnvelope(body: unknown): SnsEnvelope | null {
  if (typeof body !== "object" || body === null) return null;

  const candidate = body as Record<string, unknown>;

  const type = candidate.Type;
  if (!isNonEmptyString(type)) return null;
  if (!(SNS_MESSAGE_TYPES as readonly string[]).includes(type)) return null;

  const required = ["MessageId", "TopicArn", "Message", "Timestamp", "Signature", "SigningCertURL"];
  for (const field of required) {
    if (!isNonEmptyString(candidate[field])) return null;
  }

  // A confirmation with no token is a confirmation nothing can be done with.
  if (type !== "Notification" && !isNonEmptyString(candidate.Token)) return null;

  const envelope: SnsEnvelope = {
    Type: type as SnsMessageType,
    MessageId: candidate.MessageId as string,
    TopicArn: candidate.TopicArn as string,
    Message: candidate.Message as string,
    Timestamp: candidate.Timestamp as string,
    // Absent on some older messages; "1" is what SNS sent before the field
    // existed, and SHA-1 is what "1" means below.
    SignatureVersion: isNonEmptyString(candidate.SignatureVersion)
      ? candidate.SignatureVersion
      : "1",
    Signature: candidate.Signature as string,
    SigningCertURL: candidate.SigningCertURL as string,
    ...(isNonEmptyString(candidate.Subject) ? { Subject: candidate.Subject } : {}),
    ...(isNonEmptyString(candidate.Token) ? { Token: candidate.Token } : {}),
    ...(isNonEmptyString(candidate.SubscribeURL) ? { SubscribeURL: candidate.SubscribeURL } : {}),
  };

  return envelope;
}

/**
 * The exact bytes Amazon signed: `name\nvalue\n` for each signed field that is
 * present, concatenated in the order above.
 *
 * Exported for the tests, which sign this string with a generated key and then
 * ask `verifySnsMessage` to accept it. A canonicaliser that is only ever
 * exercised through the verifier can be wrong in a way that cancels out.
 */
export function snsStringToSign(envelope: SnsEnvelope): string {
  return SIGNED_FIELDS[envelope.Type].filter((field) => isNonEmptyString(envelope[field]))
    .map((field) => `${field}\n${envelope[field]}\n`)
    .join("");
}

/**
 * Where a signing certificate may be fetched from.
 *
 * This is the security boundary, and it is a *separate function from the fetch*
 * on purpose. An attacker who can choose this URL can serve a certificate
 * matching a signature they made themselves, so the check has to run whoever
 * ends up loading the bytes — including the injected loader the tests pass,
 * which is the case that proved the point: with the check inside the fetcher,
 * every URL below was accepted the moment a loader was supplied.
 *
 * HTTPS, an SNS host, and a path ending `.pem` — after which Node's TLS stack
 * has verified the host against the system trust store as a side effect of
 * connecting.
 */
function assertSigningCertificateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SnsVerificationError(`signing certificate URL is not a URL: ${url}`);
  }

  if (parsed.protocol !== "https:" || !SNS_HOST.test(parsed.hostname)) {
    throw new SnsVerificationError(`signing certificate URL is not an SNS host: ${url}`);
  }

  if (!parsed.pathname.endsWith(".pem")) {
    throw new SnsVerificationError(`signing certificate URL is not a certificate: ${url}`);
  }

  return parsed;
}

/** Fetch a signing certificate from an already-validated URL, and cache it. */
async function fetchCertificate(url: string): Promise<string> {
  const cached = certificates.get(url);
  if (cached) return cached;

  const parsed = assertSigningCertificateUrl(url);

  const response = await fetch(parsed.toString(), {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new SnsVerificationError(
      `could not fetch the signing certificate (${response.status}): ${url}`,
    );
  }

  const pem = await response.text();

  if (!pem.includes("BEGIN CERTIFICATE")) {
    throw new SnsVerificationError(`signing certificate URL did not return a certificate: ${url}`);
  }

  if (certificates.size >= CERTIFICATE_CACHE_LIMIT) {
    // Oldest first — insertion order is what a Map iterates in.
    const oldest = certificates.keys().next();
    if (!oldest.done) certificates.delete(oldest.value);
  }

  certificates.set(url, pem);
  return pem;
}

export type VerifySnsOptions = {
  /**
   * Injected by the tests, which verify against a generated public key rather
   * than a real Amazon certificate. Production never passes it, and the default
   * is the URL-checking fetcher above — so a test double cannot be reached from
   * anything a request can influence.
   */
  loadCertificate?: (url: string) => Promise<string>;
};

/**
 * Verify the signature on an SNS envelope.
 *
 * Throws `SnsVerificationError` when the certificate cannot be obtained —
 * that is "we could not check", which the route answers 500 to so SNS retries.
 * Returns false when the check ran and failed, which is "this is not from
 * Amazon" and gets a 403 with nothing done.
 */
export async function verifySnsMessage(
  envelope: SnsEnvelope,
  options: VerifySnsOptions = {},
): Promise<boolean> {
  // SignatureVersion 2 is SHA-256 and is what SNS sends on topics created since
  // 2022; 1 is SHA-1 and is still what an older topic sends. Anything else is a
  // version this code has not been told about, and guessing at it would mean
  // guessing at a signature check.
  const algorithm =
    envelope.SignatureVersion === "2"
      ? "RSA-SHA256"
      : envelope.SignatureVersion === "1"
        ? "RSA-SHA1"
        : null;

  if (algorithm === null) {
    throw new SnsVerificationError(
      `unknown SNS SignatureVersion ${envelope.SignatureVersion}`,
    );
  }

  // Before the loader, not inside it. Whoever loads the bytes, the URL they are
  // loaded from has already been checked — see `assertSigningCertificateUrl`.
  assertSigningCertificateUrl(envelope.SigningCertURL);

  const load = options.loadCertificate ?? fetchCertificate;
  const certificate = await load(envelope.SigningCertURL);

  try {
    return createVerify(algorithm)
      .update(snsStringToSign(envelope), "utf8")
      .verify(certificate, envelope.Signature, "base64");
  } catch {
    // A malformed certificate or a signature that is not base64. Both are
    // "no" rather than "we could not tell": nothing about retrying changes them.
    return false;
  }
}

/**
 * Complete a subscription by visiting the URL SNS sent.
 *
 * The URL is checked against the same host pattern as the certificate, and for
 * a sharper reason: this is a GET we make on Amazon's say-so, and an
 * unvalidated one is a request-forgery primitive pointed at whatever the sender
 * chooses. The route additionally refuses to call this unless the topic ARN is
 * the configured one, so confirming is only ever done for our own topic.
 */
export async function confirmSnsSubscription(subscribeUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(subscribeUrl);
  } catch {
    throw new SnsVerificationError(`subscribe URL is not a URL: ${subscribeUrl}`);
  }

  if (parsed.protocol !== "https:" || !SNS_HOST.test(parsed.hostname)) {
    throw new SnsVerificationError(`subscribe URL is not an SNS host: ${parsed.hostname}`);
  }

  const response = await fetch(parsed.toString(), {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new SnsVerificationError(
      `SNS refused the subscription confirmation (${response.status})`,
    );
  }
}
