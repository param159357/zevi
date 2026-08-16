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

Two optional ones: `SES_REPLY_TO_ADDRESS`, if replies should land somewhere
other than the From address, and `SES_CONFIGURATION_SET`, once there is a
configuration set to attribute sends to.

They are named `SES_*` rather than `AWS_*` on purpose. A Vercel function runs on
Lambda, whose runtime sets `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` for its own execution role — ours would be shadowed in
some contexts and not others, which is the worst possible way for a credential
to be wrong.

The drain runs from `vercel.json`'s cron entry every ten minutes and needs
`CRON_SECRET`, the same token the other two crons use.

## 7. The verification email is Supabase's — point it at SES too

Signup confirmation is sent by Supabase Auth, not by this codebase (see the note
at the top of `src/lib/email/templates/client.ts`). Left alone it goes out
through Supabase's built-in sender, from *their* domain, with a low hourly limit
that is fine for development and not for launch.

To bring it under the same SPF and DKIM as everything else:

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

## 8. Prove it works

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

## 9. After launch

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

- **Bounces and complaints are not wired.** SES reports them asynchronously to an
  SNS topic, and nothing here subscribes to one — so `email_status` has
  `bounced` and `complained` values that nothing sets, and
  `provider_message_id` is recorded on every sent row against the day something
  does. A complaint rate above 0.1% or a bounce rate above 5% gets an account
  suspended, so this is the next thing to build here, not an optional extra.
- **Keep the sending identity boring.** No tracking pixels, no images, a real
  `text/plain` part on every message, and nothing that is not one of spec §15's
  essential events. The in-site notification centre is where everything else
  belongs.
