/**
 * SES domain setup — SPF and DKIM, spec §15's "from day one".
 *
 * Run it directly; Node strips the types.
 *
 *   node scripts/ses-domain.ts setup   zevi.in    create the identity, turn on
 *                                                 Easy DKIM, set the custom
 *                                                 MAIL FROM, print the DNS
 *   node scripts/ses-domain.ts status  zevi.in    where verification has got to
 *   node scripts/ses-domain.ts notifications <configuration-set> <topic-arn>
 *                                                 publish bounces and
 *                                                 complaints to an SNS topic
 *
 * ### What it can and cannot do
 *
 * It can do the half that lives in Amazon: create the identity, ask for DKIM
 * keys, and set the MAIL FROM subdomain. It **cannot** publish the DNS records
 * — those go in the zone at your registrar, which no API key here has any
 * business reaching — so it prints them and then tells you what to run to check
 * whether they have propagated. That division is the whole reason this is a
 * script and not a migration.
 *
 * The same division applies to `notifications`. It does the SES side — the
 * configuration set and the event destination pointed at a topic — and not the
 * SNS side, because creating a topic and subscribing an endpoint to it is two
 * `aws sns` commands against a service this codebase otherwise never touches.
 * Those two commands are in docs/email-setup.md.
 *
 * ### Why a custom MAIL FROM, when DKIM alone would pass DMARC
 *
 * Because otherwise SPF authenticates `amazonses.com` rather than `zevi.in`:
 * the *envelope* sender is Amazon's, even though the From: header is ours. A
 * DMARC check would still pass on DKIM alignment alone, and the mail would look
 * to a receiver like a domain that has never bothered with SPF. Setting
 * `mail.zevi.in` as the MAIL FROM domain, with its own SPF record, aligns both
 * — which is the difference between "passes" and "passes twice", and on a
 * cold-start sending reputation that difference is the inbox.
 *
 * ### Credentials
 *
 * The same `SES_*` variables the app uses, read from `.env.local`. The IAM user
 * needs `ses:CreateEmailIdentity`, `ses:GetEmailIdentity` and
 * `ses:PutEmailIdentityMailFromAttributes` for `setup` — which is *more* than
 * the sending user should hold. Use an admin's keys once and leave the app's
 * user with `ses:SendEmail` only. See docs/email-setup.md.
 */

import { readFileSync } from "node:fs";

import { signRequest } from "../src/lib/email/sigv4.ts";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * A five-line `.env.local` reader rather than a dependency. Handles `KEY=value`
 * and quoted values; anything more exotic belongs in the shell.
 */
function loadEnvFile(path: string): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Put it in .env.local or the environment.`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// SES
// ---------------------------------------------------------------------------

type SesCall = { method: "GET" | "POST" | "PUT"; path: string; body?: unknown };

async function ses<T>({ method, path, body }: SesCall): Promise<T> {
  const region = required("SES_REGION");
  const serialised = body === undefined ? "" : JSON.stringify(body);

  const signed = signRequest({
    method,
    url: `https://email.${region}.amazonaws.com${path}`,
    region,
    service: "ses",
    body: serialised,
    accessKeyId: required("SES_ACCESS_KEY_ID"),
    secretAccessKey: required("SES_SECRET_ACCESS_KEY"),
    headers: serialised === "" ? {} : { "content-type": "application/json" },
  });

  const response = await fetch(signed.url, {
    method,
    headers: signed.headers,
    body: serialised === "" ? undefined : serialised,
  });

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const code = response.headers.get("x-amzn-errortype")?.split(/[:\s]/)[0] ?? "Error";
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : response.statusText;

    throw Object.assign(new Error(`${code}: ${message}`), { code });
  }

  return payload as T;
}

type IdentityResponse = {
  VerifiedForSendingStatus?: boolean;
  VerificationStatus?: string;
  DkimAttributes?: {
    Status?: string;
    Tokens?: string[];
    SigningEnabled?: boolean;
  };
  MailFromAttributes?: {
    MailFromDomain?: string;
    MailFromDomainStatus?: string;
  };
};

// ---------------------------------------------------------------------------
// The DNS records, which are the actual output of this script
// ---------------------------------------------------------------------------

type DnsRecord = { type: string; name: string; value: string; note: string };

function dnsRecords(
  domain: string,
  region: string,
  tokens: string[],
  mailFromDomain: string,
): DnsRecord[] {
  return [
    ...tokens.map((token) => ({
      type: "CNAME",
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
      note: "DKIM. All three, or signing never turns on.",
    })),
    {
      type: "MX",
      name: mailFromDomain,
      value: `10 feedback-smtp.${region}.amazonses.com`,
      note: "MAIL FROM: where bounces are returned to.",
    },
    {
      type: "TXT",
      name: mailFromDomain,
      value: '"v=spf1 include:amazonses.com ~all"',
      note: "SPF, on the MAIL FROM subdomain — this is the one that aligns.",
    },
    {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `"v=DMARC1; p=none; rua=mailto:dmarc@${domain}"`,
      note: "DMARC. Start at p=none, read the reports for a fortnight, then move to quarantine.",
    },
  ];
}

function printRecords(records: DnsRecord[]): void {
  console.log("\nPublish these in the DNS zone for the domain:\n");

  for (const record of records) {
    console.log(`  ${record.type.padEnd(6)} ${record.name}`);
    console.log(`  ${"".padEnd(6)} ${record.value}`);
    console.log(`  ${"".padEnd(6)} — ${record.note}\n`);
  }

  console.log(
    "Amazon checks for them itself and flips the identity to verified, usually\n" +
      "within an hour. Nothing sends until it does.\n",
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setup(domain: string): Promise<void> {
  const region = required("SES_REGION");
  const mailFromDomain = `mail.${domain}`;

  console.log(`Setting up ${domain} in ${region}.\n`);

  let identity: IdentityResponse;

  try {
    identity = await ses<IdentityResponse>({
      method: "POST",
      path: "/v2/email/identities",
      body: {
        EmailIdentity: domain,
        // Easy DKIM: Amazon holds the private key and publishes three CNAMEs
        // for us to point at. The alternative — BYODKIM — means minding a
        // private key, which is a worse trade for a platform this size.
        DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048" },
      },
    });
    console.log("Created the identity and asked for DKIM keys.");
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code !== "AlreadyExistsException") throw error;

    console.log("The identity already exists — reading it instead.");
    identity = await ses<IdentityResponse>({
      method: "GET",
      path: `/v2/email/identities/${domain}`,
    });
  }

  await ses({
    method: "PUT",
    path: `/v2/email/identities/${domain}/mail-from`,
    body: {
      MailFromDomain: mailFromDomain,
      // Refuse to send rather than fall back to amazonses.com. A silent
      // fallback is how you find out months later that half your mail has been
      // failing SPF alignment.
      BehaviorOnMxFailure: "REJECT_MESSAGE",
    },
  });
  console.log(`Set the MAIL FROM domain to ${mailFromDomain}.`);

  const tokens = identity.DkimAttributes?.Tokens ?? [];

  if (tokens.length === 0) {
    console.error(
      "\nSES returned no DKIM tokens. Run `status` in a minute — they are\n" +
        "occasionally generated a moment after the identity is created.",
    );
    return;
  }

  printRecords(dnsRecords(domain, region, tokens, mailFromDomain));
  console.log(`Then: node scripts/ses-domain.ts status ${domain}\n`);
}

async function status(domain: string): Promise<void> {
  const identity = await ses<IdentityResponse>({
    method: "GET",
    path: `/v2/email/identities/${domain}`,
  });

  const dkim = identity.DkimAttributes ?? {};
  const mailFrom = identity.MailFromAttributes ?? {};

  console.log(`\n${domain}\n`);
  console.log(`  identity      ${identity.VerificationStatus ?? "unknown"}`);
  console.log(`  can send      ${identity.VerifiedForSendingStatus ? "yes" : "no"}`);
  console.log(`  DKIM          ${dkim.Status ?? "unknown"} (signing ${dkim.SigningEnabled ? "on" : "off"})`);
  console.log(
    `  MAIL FROM     ${mailFrom.MailFromDomain ?? "not set"} — ${mailFrom.MailFromDomainStatus ?? "unknown"}`,
  );

  const pending =
    !identity.VerifiedForSendingStatus ||
    dkim.Status !== "SUCCESS" ||
    mailFrom.MailFromDomainStatus !== "SUCCESS";

  if (pending) {
    console.log(
      "\nStill pending. `PENDING` means Amazon has not seen the records yet;\n" +
        "`FAILED` means it looked and they were wrong. Check them with:\n" +
        `  nslookup -type=TXT ${mailFrom.MailFromDomain ?? `mail.${domain}`}\n` +
        `  nslookup -type=MX  ${mailFrom.MailFromDomain ?? `mail.${domain}`}\n`,
    );
  } else {
    console.log(
      "\nVerified, signed and aligned. Remaining: production access (the SES\n" +
        "sandbox only sends to verified addresses) — docs/email-setup.md.\n",
    );
  }
}

/**
 * Point bounces and complaints at an SNS topic.
 *
 * Two SES calls, both idempotent enough to re-run: the configuration set, and
 * an event destination on it publishing to the topic. The endpoint that reads
 * the topic is `/api/webhooks/ses`, and it refuses every delivery until
 * `SES_SNS_TOPIC_ARN` matches what is passed here.
 *
 * **DELIVERY is deliberately not among the events.** Subscribing it would put a
 * row in `email_events` for every message that arrives safely — the overwhelming
 * majority — in exchange for a fact `email_outbox.status` already records. The
 * four below are the ones something is done about: two suppress an address, one
 * means SES refused to send at all, and the fourth is the only way to tell a
 * slow receiver from a broken one.
 */
async function notifications(configurationSet: string, topicArn: string): Promise<void> {
  const destinationName = "zevi-feedback";
  const events = ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"];

  console.log(`Publishing ${events.join(", ")} from "${configurationSet}" to the topic.\n`);

  try {
    await ses({
      method: "POST",
      path: "/v2/email/configuration-sets",
      body: { ConfigurationSetName: configurationSet },
    });
    console.log(`Created the configuration set "${configurationSet}".`);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code !== "AlreadyExistsException") throw error;
    console.log(`The configuration set "${configurationSet}" already exists.`);
  }

  const destination = {
    Enabled: true,
    MatchingEventTypes: events,
    SnsDestination: { TopicArn: topicArn },
  };

  try {
    await ses({
      method: "POST",
      path: `/v2/email/configuration-sets/${configurationSet}/event-destinations`,
      body: { EventDestinationName: destinationName, EventDestination: destination },
    });
    console.log(`Created the event destination "${destinationName}".`);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code !== "AlreadyExistsException") throw error;

    await ses({
      method: "PUT",
      path:
        `/v2/email/configuration-sets/${configurationSet}` +
        `/event-destinations/${destinationName}`,
      body: { EventDestination: destination },
    });
    console.log(`Updated the existing event destination "${destinationName}".`);
  }

  console.log(
    "\nSES will publish to the topic from now on. Two things remain, and both\n" +
      "are outside SES — docs/email-setup.md has the commands:\n\n" +
      "  1. subscribe <origin>/api/webhooks/ses to the topic, and let the\n" +
      "     endpoint confirm it (it does that itself, once the ARN is set)\n" +
      "  2. set these in the environment, or nothing is attributed and the\n" +
      "     endpoint refuses every delivery:\n\n" +
      `       SES_CONFIGURATION_SET=${configurationSet}\n` +
      `       SES_SNS_TOPIC_ARN=${topicArn}\n`,
  );
}

// ---------------------------------------------------------------------------

const USAGE =
  "usage: node scripts/ses-domain.ts <setup|status> <domain>\n" +
  "       node scripts/ses-domain.ts notifications <configuration-set> <topic-arn>\n" +
  "  e.g. node scripts/ses-domain.ts setup zevi.in\n" +
  "       node scripts/ses-domain.ts notifications zevi-email \\\n" +
  "         arn:aws:sns:ap-south-1:123456789012:zevi-email-feedback";

async function main(): Promise<void> {
  loadEnvFile(".env.local");

  const [command, first, second] = process.argv.slice(2);

  if (command === "notifications") {
    if (!first || !second) {
      console.error(USAGE);
      process.exit(1);
    }

    // The name goes into the request path, and `signRequest` refuses a path
    // needing URI encoding rather than signing something it cannot promise.
    // Catching it here says which argument is wrong.
    if (!/^[A-Za-z0-9_-]+$/.test(first)) {
      console.error(
        `"${first}" is not a configuration set name — letters, digits, dashes and underscores only.`,
      );
      process.exit(1);
    }

    if (!/^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/.test(second)) {
      console.error(
        `"${second}" is not an SNS topic ARN.\n` +
          "  e.g. arn:aws:sns:ap-south-1:123456789012:zevi-email-feedback",
      );
      process.exit(1);
    }

    await notifications(first, second);
    return;
  }

  const domain = first;

  if ((command !== "setup" && command !== "status") || !domain) {
    console.error(USAGE);
    process.exit(1);
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    console.error(`"${domain}" is not a domain name. Give the bare domain, no scheme, no @.`);
    process.exit(1);
  }

  if (command === "setup") await setup(domain);
  else await status(domain);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
