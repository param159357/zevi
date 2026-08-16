/**
 * Amazon SES v2, the one call this platform makes: `SendEmail`.
 *
 * **Server-only.** Reads the SES credentials through `serverEnv`.
 *
 * Same shape as `lib/payments/razorpay.ts` — a typed wrapper over the endpoint
 * we actually use, an error class that separates "Amazon is busy" from "Amazon
 * says no", and a bounded wait. The signing is in `sigv4.ts`.
 *
 * ### What a failure means here
 *
 * `retryable` is the whole reason this class exists. SES rejects for two very
 * different sorts of reason and the queue must not treat them alike:
 *
 *   * `TooManyRequestsException`, `Throttling`, any 5xx — the account's sending
 *     rate, or Amazon having a moment. The same email will go out fine in a
 *     minute.
 *   * `MessageRejected`, `MailFromDomainNotVerifiedException`,
 *     `AccountSuspendedException` — the message, the identity or the account is
 *     wrong. Retrying is just four more identical refusals, and on a suspended
 *     account it is four more marks against a reputation already in trouble.
 *
 * A bounce is neither: SES accepts the message, returns a `MessageId`, and the
 * recipient's server rejects it minutes later. Those arrive asynchronously on an
 * SNS topic, which `app/api/webhooks/ses` subscribes to — and the `MessageId`
 * returned below is the only handle that ties one back to a row, which is why it
 * is recorded on every sent row and why a 200 without one is treated as
 * impossible. `lib/email/feedback.ts` is what happens next.
 *
 * That path only carries events for messages sent through a *configuration set*,
 * so `SES_CONFIGURATION_SET` is what makes a send attributable and therefore
 * reportable. Without it the topic is configured and silent. See
 * `docs/email-setup.md`.
 */

import { serverEnv } from "@/lib/env";
import { signRequest } from "@/lib/email/sigv4";

/** SES is not in a user's request path — a queue drain is what waits on it. */
const REQUEST_TIMEOUT_MS = 15_000;

export class SesError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message);
    this.name = "SesError";
    this.status = options.status;
    this.code = options.code ?? null;

    const transient = new Set([
      "TooManyRequestsException",
      "ThrottlingException",
      "Throttling",
      "ServiceUnavailable",
      "InternalServiceErrorException",
      "ConcurrentModificationException",
    ]);

    // 0 is a network failure or a timeout: no answer, not a negative one.
    this.retryable =
      options.status === 0 ||
      options.status === 429 ||
      options.status >= 500 ||
      transient.has(options.code ?? "");
  }
}

export type SesRequestInit = {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
};

/**
 * One request, one place that knows how SES reports a failure.
 *
 * Errors come back as `{"message": "…"}` with the class in the
 * `x-amzn-errortype` header — `MessageRejected:` and sometimes a URL after it,
 * which is trimmed off so the code is comparable.
 *
 * Exported because the domain setup script (`scripts/ses-domain.mjs`) talks to
 * the identity endpoints with the same credentials and the same error envelope.
 */
export async function sesRequest<T>({ method, path, body }: SesRequestInit): Promise<T> {
  const region = serverEnv.sesRegion;
  const serialised = body === undefined ? "" : JSON.stringify(body);

  const signed = signRequest({
    method,
    url: `https://email.${region}.amazonaws.com${path}`,
    region,
    service: "ses",
    body: serialised,
    accessKeyId: serverEnv.sesAccessKeyId,
    secretAccessKey: serverEnv.sesSecretAccessKey,
    headers: serialised === "" ? {} : { "content-type": "application/json" },
  });

  let response: Response;

  try {
    response = await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: serialised === "" ? undefined : serialised,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    throw new SesError(`Could not reach SES (${method} ${path}): ${reason}`, { status: 0 });
  }

  const text = await response.text();

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code = (response.headers.get("x-amzn-errortype") ?? "").split(/[:\s]/)[0] || null;
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : response.statusText;

    throw new SesError(`SES refused ${method} ${path}: ${message}`, {
      status: response.status,
      code,
    });
  }

  return (payload ?? {}) as T;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Carried into SES's event stream as `template`, so a deliverability problem
   * can be traced to one email rather than to "the platform". Also the outbox
   * row's id, for the same reason from the other direction.
   */
  tags?: Record<string, string>;
};

/**
 * Send one message. Returns SES's message id, which goes on the outbox row —
 * it is the only handle a bounce notification can be matched back to.
 *
 * Both bodies are always sent. A text part is not a courtesy: a message with no
 * `text/plain` alternative scores worse with every spam filter that looks, and
 * spec §15's own warning is about landing in spam.
 */
export async function sendEmail(input: SendEmailInput): Promise<string> {
  const configurationSet = process.env.SES_CONFIGURATION_SET;
  const replyTo = process.env.SES_REPLY_TO_ADDRESS;

  const response = await sesRequest<{ MessageId?: string }>({
    method: "POST",
    path: "/v2/email/outbound-emails",
    body: {
      FromEmailAddress: serverEnv.sesFromAddress,
      Destination: { ToAddresses: [input.to] },
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
      ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
      ...(input.tags
        ? {
            EmailTags: Object.entries(input.tags).map(([Name, Value]) => ({
              // SES accepts letters, digits, underscores and dashes in a tag
              // value and rejects the whole send otherwise — a job id with a
              // colon in it would fail a receipt, which is not a trade worth
              // making for a tag.
              Name,
              Value: Value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 256),
            })),
          }
        : {}),
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: input.text, Charset: "UTF-8" },
            Html: { Data: input.html, Charset: "UTF-8" },
          },
        },
      },
    },
  });

  if (!response.MessageId) {
    // SES answering 200 with no id would mean we cannot match a later bounce to
    // this message. Loud, because it should be impossible.
    throw new SesError("SES accepted the message but returned no MessageId", { status: 200 });
  }

  return response.MessageId;
}
