# Email: SES, SPF and DKIM

Spec §15 puts the warning in the requirement itself:

> **Set up SPF and DKIM from day one** or half of these land in spam — which on
> a website-only platform means users never hear from you.

That is the whole reason this document exists. Sending is the easy half; being
*delivered* is the half that takes DNS records, and no amount of application
code substitutes for them.

This is a runbook. The code it refers to is in [`src/lib/email/`](../src/lib/email),
and the design notes live in [CLAUDE.md](../CLAUDE.md#email).

---

## What you need before you start

- The domain, and access to its DNS zone. Every step below that matters happens
  there, not in AWS.
- An AWS account, and a region. **`ap-south-1` (Mumbai)** — SES identities are
  regional, everyone on this platform is in India, and the region you verify in
  is the region you must send from.
- Twenty minutes, plus up to 72 hours of waiting: DNS propagation for
  verification, and one to two working days for AWS to grant production access.

---

## 1. Two IAM users, not one

The application only ever sends. Give it exactly that:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ses:SendEmail"], "Resource": "*" }
  ]
}
```

Setting the domain up needs more — `ses:CreateEmailIdentity`,
`ses:GetEmailIdentity`, `ses:PutEmailIdentityMailFromAttributes` — and it needs
it once. Use an admin's credentials for step 2 and leave the application's user
with the policy above. A key that can send is a key that can spend your sending
reputation if it leaks; a key that can also reconfigure your identities is a key
that can redirect your bounces.

## 2. Create the identity, turn on DKIM, set the MAIL FROM

```bash
node scripts/ses-domain.ts setup zevi.in
```

The script creates the domain identity with Easy DKIM (Amazon holds the private
key; we publish three CNAMEs), sets `mail.zevi.in` as the custom MAIL FROM
domain, and prints the DNS records to publish.

**Why the custom MAIL FROM.** Without it the envelope sender is Amazon's, so SPF
authenticates `amazonses.com` rather than `zevi.in`. DMARC would still pass on
DKIM alignment alone — and the mail would look to every receiver like a domain
that never bothered with SPF. A MAIL FROM subdomain with its own SPF record
aligns both. On a cold-start sending reputation, that difference is the inbox.

## 3. Publish the DNS records

The script prints these filled in. Four kinds, and all four matter:

| Type | Name | Value | Why |
|---|---|---|---|
| CNAME ×3 | `<token>._domainkey.zevi.in` | `<token>.dkim.amazonses.com` | DKIM. **All three** — Amazon rotates between them and signing never turns on until every one resolves. |
| MX | `mail.zevi.in` | `10 feedback-smtp.ap-south-1.amazonses.com` | Where bounces come back to. |
| TXT | `mail.zevi.in` | `"v=spf1 include:amazonses.com ~all"` | SPF, on the MAIL FROM subdomain. This is the record that aligns. |
| TXT | `_dmarc.zevi.in` | `"v=DMARC1; p=none; rua=mailto:dmarc@zevi.in"` | DMARC. Tells receivers what to do when alignment fails, and asks for reports. |

Three things that go wrong here:

- **Do not add `include:amazonses.com` to the apex SPF record.** The aligned SPF
  is the one on `mail.zevi.in`. Adding it at the apex authorises Amazon to send
  as your bare domain, which is a wider grant than you need.
- **One SPF record per name.** Two `v=spf1` TXT records on the same name is a
  permanent error and fails *both*. If the apex already has one for Google
  Workspace, leave it alone.
- Some DNS providers append the zone name to a record you enter fully qualified,
  turning `mail.zevi.in` into `mail.zevi.in.zevi.in`. Check what the record
  reads as after you save it.

## 4. Wait, then check

```bash
node scripts/ses-domain.ts status zevi.in
```

`PENDING` means Amazon has not seen the records yet. `FAILED` means it looked
and they were wrong — check with `nslookup -type=TXT mail.zevi.in`. Verification
usually completes within the hour and can take up to 72.

## 5. Leave the sandbox

A new SES account can only send to addresses it has verified. Request production
access in the SES console (Account dashboard → Request production access) and
say what the mail is: transactional notifications to registered users of a
freelance marketplace, no marketing, roughly N per day. It is usually granted
within a working day.

Until then, verify your own address as an identity and test with that.

## 6. Configure the application

In `.env.local` locally and in the Vercel project settings for deploys:

```
SES_REGION=ap-south-1
SES_ACCESS_KEY_ID=…
SES_SECRET_ACCESS_KEY=…
SES_FROM_ADDRESS=Zevi <no-reply@zevi.in>
```

`SES_REPLY_TO_ADDRESS` is optional, if replies should land somewhere other than
the From address. `SES_CONFIGURATION_SET` and `SES_SNS_TOPIC_ARN` come from the
next section and are not optional for long.

They are named `SES_*` rather than `AWS_*` on purpose. A Vercel function runs on
Lambda, whose runtime sets `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` for its own execution role — ours would be shadowed in
some contexts and not others, which is the worst possible way for a credential
to be wrong.

The drain runs from `vercel.json`'s cron entry every ten minutes and needs
`CRON_SECRET`, the same token the other two crons use.

## 7. Bounces and complaints

Everything above is about mail going out. This is about finding out when it did
not arrive, and it is the step that decides whether the account survives its
first year.

SES suspends an account over a **5% bounce rate** or a **0.1% complaint rate**,
and both are measured across the whole account rather than per message. A
hundred addresses that no longer exist, retried politely for ever, take the
receipts, the payout notices and the dispute mail down with them. That is spec
§15's stated failure mode — users never hearing from you — reached by the
shortest available route.

SES reports both asynchronously: it accepts the message, returns a `MessageId`,
and the recipient's server rejects it minutes later. That report goes to an SNS
topic, which POSTs it to `/api/webhooks/ses`.

### 7.1 Create the topic and subscribe the endpoint

Two commands against a service nothing else here touches, so they are the AWS
CLI's rather than the script's:

```bash
aws sns create-topic --name zevi-email-feedback --region ap-south-1
```

```bash
aws sns subscribe --region ap-south-1 --protocol https --topic-arn arn:aws:sns:ap-south-1:123456789012:zevi-email-feedback --notification-endpoint https://zevi.in/api/webhooks/ses
```

The subscription starts as `PendingConfirmation`. SNS immediately POSTs a
`SubscriptionConfirmation` to the endpoint, which verifies it and confirms it
itself — **but only once `SES_SNS_TOPIC_ARN` is set and deployed**, because
until then the route refuses every delivery. Set the variable first, deploy,
then subscribe. Check it took:

```bash
aws sns list-subscriptions-by-topic --region ap-south-1 --topic-arn arn:aws:sns:ap-south-1:123456789012:zevi-email-feedback
```

### 7.2 Point SES at the topic

```bash
node scripts/ses-domain.ts notifications zevi-email arn:aws:sns:ap-south-1:123456789012:zevi-email-feedback
```

That creates the configuration set if it does not exist and puts an event
destination on it publishing `BOUNCE`, `COMPLAINT`, `REJECT` and
`DELIVERY_DELAY`. `DELIVERY` is deliberately left off: it would write a row for
every message that arrives safely, which is nearly all of them, to record a fact
`email_outbox.status` already holds.

Then set both variables, in `.env.local` and in Vercel:

```
SES_CONFIGURATION_SET=zevi-email
SES_SNS_TOPIC_ARN=arn:aws:sns:ap-south-1:123456789012:zevi-email-feedback
```

`SES_CONFIGURATION_SET` is what makes a send get attributed to the set, and
therefore what makes its events get published at all. Without it the topic is
configured and silent.

### 7.3 What happens to an address that bounces

| Event | Outbox row | The address |
|---|---|---|
| Permanent bounce | `bounced` | suppressed immediately |
| Complaint | `complained` | suppressed immediately |
| Transient bounce | `bounced` | suppressed on the 3rd in 7 days |
| Reject | `failed` | untouched — SES refused to send, which is our problem |
| Delivery delay | unchanged | untouched |

A suppressed address is not mailed again. `enqueue_email()` still writes the
row — in `cancelled`, with the reason on it — and still writes the in-site
notification, so the user sees on the site what they would have been sent. The
email channel is what failed, not the event.

The two thresholds are `platform_settings`, not constants:
`email.transient_bounce_limit` and `email.transient_bounce_window_days`.

### 7.4 Lifting a suppression

There is no console screen for this yet. A mailbox that was full for a
fortnight, or a shared address where a colleague pressed "spam", is a real
support case, so the function exists and writes an audit row:

```sql
select * from release_email_suppression(
  'someone@example.com',
  '<your admin profile id>',
  'Mailbox was full during a move; user confirmed it works.'
);
```

It needs `manage_users`. The events stay — a release means "send to this address
again", not "that never happened" — so a later bounce revives the same row with
`event_count` still climbing.

### 7.5 Testing it

SES's mailbox simulator bounces and complains on demand, and neither counts
against the account's reputation. Send to these from a job on a staging
deployment:

```
bounce@simulator.amazonses.com
complaint@simulator.amazonses.com
```

Then look:

```sql
select event_type, subtype, recipient, diagnostic, occurred_at
from email_events order by created_at desc limit 10;

select email, reason, event_count, suppressed_at from email_suppressions
where released_at is null;
```

Nothing arriving means the subscription is unconfirmed, `SES_CONFIGURATION_SET`
is unset, or the endpoint is returning non-2xx — the Vercel logs say which, and
every refusal is logged with `[ses-webhook]`.

## 8. Two emails are Supabase's — point them at SES too

Signup confirmation and password reset are sent by Supabase Auth, not by this
codebase (see the note at the top of `src/lib/email/templates/client.ts`). The
token in each is GoTrue's to mint, so neither is a template in `lib/email`. Left
alone they go out through Supabase's built-in sender, from *their* domain, with a
low hourly limit that is fine for development and not for launch.

To bring them under the same SPF and DKIM as everything else:

1. SES console → SMTP settings → **Create SMTP credentials**. This makes its own
   IAM user; it is not the same key pair as above.
2. Supabase dashboard → Project Settings → Authentication → SMTP Settings →
   Enable custom SMTP:
   - Host `email-smtp.ap-south-1.amazonaws.com`, port `587`, TLS on
   - Username and password from step 1
   - Sender `no-reply@zevi.in`, sender name `Zevi`
3. Supabase → Authentication → Email Templates. Paste in the branded HTML if you
   want it to match the rest — run the dev server and open
   `http://localhost:3000/dev/emails` to see what the rest looks like, and keep
   Supabase's `{{ .ConfirmationURL }}` placeholder as the link.

Both templates also need `/auth/callback` on the redirect allow list — Supabase →
Authentication → URL Configuration. Without it Supabase silently falls back to
the Site URL and every link lands on the home page.

### 8.1 Making a reset link work on a second device

Out of the box `{{ .ConfirmationURL }}` sends the PKCE shape: the link carries a
`code`, and exchanging it needs the verifier cookie that `resetPasswordForEmail`
left in the browser that asked. Open the mail on a phone and the exchange fails —
`/auth/callback` catches that and returns the person to `/forgot-password` with a
"open it in this browser" notice, which is honest but is still a dead end for
anyone who reads mail on a different device from the one they browse on.

The fix is a template change, not a code change. Supabase → Authentication →
Email Templates → **Reset Password**, and swap the link for the token-hash form:

```
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery
```

`/auth/callback` already handles that shape, and `type=recovery` is a stronger
signal than the `next` parameter the PKCE shape relies on — no verifier cookie is
involved, so the link works anywhere. Do the same on **Confirm signup** with
`type=signup` if the same complaint turns up there.

## 9. Prove it works

Locally, without any of the above: every email is printed to the server console
instead of being sent. Trigger one (pick a worker on a job, deliver, accept) and
then drain the queue:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/email
```

Once SES is configured, send one to a real address and open it in Gmail →
**Show original**. You want three lines:

```
SPF:   PASS with domain mail.zevi.in
DKIM:  PASS with domain zevi.in
DMARC: PASS
```

If DKIM says `zevi.in` and SPF says `amazonses.com`, the MAIL FROM records have
not taken effect. If DMARC fails while both of the others pass, the alignment is
wrong rather than the authentication — check that the DKIM domain matches the
From: domain exactly.

## 10. After launch

- **Move DMARC on.** `p=none` collects reports and enforces nothing. Read a
  fortnight of them, then `p=quarantine`, then `p=reject`. Do not start at
  reject: the first thing it rejects is usually your own forgotten sender.
- **Watch `email_outbox`.** Anything in `failed` is somebody who did not hear
  from us:

  ```sql
  select template, error, count(*)
  from email_outbox
  where status in ('failed', 'bounced', 'complained')
  group by 1, 2 order by 3 desc;
  ```

- **Watch the rates Amazon is watching.** Section 7 wires the reporting; this is
  the number to read off it. Anything approaching 5% bounces or 0.1% complaints
  is an account heading for suspension, and the SES console's reputation
  dashboard is the authority — this is the same question asked of our own rows:

  ```sql
  select event_type, count(*)
  from email_events
  where occurred_at > now() - interval '7 days'
  group by 1 order by 2 desc;
  ```

  A bounce rate that climbs suddenly is usually one template with a bad link, or
  a signup flow accepting typo'd addresses. A complaint rate that climbs is a
  message people did not expect, which spec §15 has an answer for: send only the
  essential events, and put everything else in the notification centre.
- **Keep the sending identity boring.** No tracking pixels, no images, a real
  `text/plain` part on every message, and nothing that is not one of spec §15's
  essential events. The in-site notification centre is where everything else
  belongs.
