/**
 * AWS Signature Version 4, as much of it as SES needs.
 *
 * **Server-only.** Every caller reads `AWS_SECRET_ACCESS_KEY` through
 * `serverEnv`; nothing here belongs in a browser bundle.
 *
 * No SDK, for the reason `lib/payments/razorpay.ts` gives about Razorpay's:
 * `@aws-sdk/client-sesv2` brings a credential-provider chain, a retry engine,
 * a middleware stack and its own HTTP client into a runtime that already has
 * `fetch`, to sign one POST to one endpoint. The signing algorithm below is
 * about seventy lines, it is fully specified by AWS, and — the part that
 * matters — AWS publishes test vectors for it, so it is checked against
 * somebody else's arithmetic rather than against our own. See `sigv4.test.ts`.
 *
 * What is deliberately *not* implemented:
 *
 *   * **Double URI-encoding of the path.** Every service except S3 wants the
 *     path encoded twice in the canonical request. SES's one path is
 *     `/v2/email/outbound-emails`, which contains nothing that encodes to
 *     anything but itself, so the distinction cannot arise here. A path with a
 *     space or a `+` in it would sign wrongly, which is why `signRequest`
 *     refuses one rather than signing something it cannot promise.
 *   * **Session tokens / IMDS / SSO.** Credentials are a static key pair from
 *     the environment, which is what a Vercel deployment has.
 *   * **Chunked or streaming payloads.** The body is a string we just built.
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";

/** Characters that survive AWS's canonical URI encoding untouched. */
const SAFE_PATH = /^[A-Za-z0-9\-._~/]*$/;

export type SigV4Input = {
  /** Whatever verb the request will actually be sent with — it is signed. */
  method: "GET" | "POST" | "PUT";
  /** Absolute URL. Query parameters are honoured; fragments are not signed. */
  url: string;
  region: string;
  service: string;
  /** Already-serialised request body. Empty string for a GET. */
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Headers to sign on top of `host` and `x-amz-date`, which are always added.
   * Anything passed here is both signed and sent — the two lists must agree or
   * AWS rejects the request.
   */
  headers?: Record<string, string>;
  /** Injectable for the test vectors, which fix the clock. */
  now?: Date;
};

export type SignedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** `20150830T123600Z` and `20150830` — the two forms AWS asks for. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * AWS encodes query values with the unreserved set of RFC 3986, which
 * `encodeURIComponent` almost gets right — it leaves `!'()*` alone and AWS
 * wants them escaped.
 */
function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    pairs.push([encodeQueryComponent(name), encodeQueryComponent(value)]);
  });

  // Sorted by encoded name, then by encoded value — AWS is explicit that the
  // comparison happens after encoding, not before.
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));

  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/**
 * Sign a request and return it with `Authorization` and `X-Amz-Date` attached.
 *
 * Pure apart from the clock, which is why the vectors in `sigv4.test.ts` can
 * pin an exact signature: same inputs, same bytes, every time.
 */
export function signRequest(input: SigV4Input): SignedRequest {
  const url = new URL(input.url);

  const path = url.pathname === "" ? "/" : url.pathname;
  if (!SAFE_PATH.test(path)) {
    // Signing this would need the double-encoding rule above. Failing here is a
    // developer's bug caught at the first call, not a 403 in production that
    // reads like a credential problem.
    throw new Error(`sigv4: path ${path} needs URI encoding, which this signer does not do`);
  }

  const { amzDate, dateStamp } = amzDates(input.now ?? new Date());

  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": amzDate,
  };

  // Canonical headers: lowercase names, collapsed values, sorted by name.
  const canonicalNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();

  const lowercased = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value.trim().replace(/\s+/g, " "),
    ]),
  );

  const canonicalHeaders = canonicalNames
    .map((name) => `${name}:${lowercased.get(name) ?? ""}\n`)
    .join("");
  const signedHeaders = canonicalNames.join(";");

  const payloadHash = sha256Hex(input.body);

  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/${TERMINATOR}`;

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  // The signing key is derived per day, per region, per service — which is why
  // a leaked one is worth less than the secret it came from.
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, input.service);
  const signingKey = hmac(serviceKey, TERMINATOR);

  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    url: input.url,
    method: input.method,
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: input.body,
  };
}
