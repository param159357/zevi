# Deploying Zevi to Vercel

The runbook for putting this on the internet. Companion to
[email-setup.md](email-setup.md), which owns the SPF/DKIM half of §5.3.

This deployment is **Vercel Hobby + an external scheduler**, functions pinned to
**Mumbai (`bom1`)**, against a **fresh production Supabase project**. Each of
those is a decision with consequences, and they are recorded in §0 so the next
person does not have to re-derive them.

---

## Read this before announcing the URL

**Signup needs DLT registration, and DLT takes three to seven working days.**
This does not stop the deploy, and it is no longer a gap in the code — the
provider is wired. It is a lead time.

Spec §5 and §6 both make mobile verification compulsory, and `resolveStep()`
returns `verify_mobile` until `profiles.mobile_verified_at` is set.
`verify_phone_otp()` is the only writer of that column and it needs an OTP the
user received. MSG91 sends it (`lib/sms/msg91.ts`), but India's DLT regime will
not carry a commercial SMS until the business entity, the six-character sender
header and the exact message text are each registered and approved with the
operators. Until `MSG91_AUTH_KEY`, `MSG91_SENDER_ID` and `MSG91_OTP_TEMPLATE_ID`
are set, `isSmsConfigured()` is false and `sendVerificationSms()` **throws**
`SmsNotConfiguredError` when `NODE_ENV === "production"`. In development it
prints the code to the server console, which is why the flow works locally
without any of this.

That behaviour is deliberate — a signup that silently strands every user at the
mobile step is worse than one that fails loudly — but the consequence is that the
deployed site is a staging environment until DLT approval lands, no matter how
correct everything else in this runbook is.

So: **start [sms-setup.md](sms-setup.md) before you start this file**, since it
is the only step here measured in days rather than minutes. Then deploy, verify,
and use it as staging until the header and template are approved.

---

## 0. The three decisions behind this shape

**Hobby rejects sub-daily crons at deploy time.** Not at runtime — the build
fails with *"Hobby accounts are limited to daily cron jobs"*. Three of the four
schedules this platform needs (hourly auto-accept, ten-minute outbox drain,
fifteen-minute refund drain) are sub-daily, so `vercel.json` keeps only the
daily payout run and the other three are driven from outside. All four routes
authenticate on `Authorization: Bearer $CRON_SECRET` alone, compared in constant
time, with no Vercel-specific signature — so an external caller is
indistinguishable from Vercel Cron to them. That is what makes this substitution
safe rather than a workaround.

**GitHub Actions is the wrong carrier here.** The repo is private, and private
repos draw scheduled workflows from a 2,000 minute/month allowance with each run
billed as a whole minute. Hourly + every-10-min + every-15-min is ~264 runs a
day, ~7,900 minutes a month — about four times the allowance, and more than the
Pro plan that was being avoided. Actions schedules are also delayed under load
and are disabled automatically after 60 days of repository inactivity, which is
a silent stop on the sweep that releases people's money. §6 uses cron-job.org or
Supabase `pg_cron` instead.

**`bom1` because the data is in Mumbai.** Vercel functions default to `iad1`
(Washington DC). Every screen here is a Server Component making several
sequential Supabase queries; from `iad1` to a Mumbai Postgres that is roughly
200–250 ms of round trip *per query*, serially, before any rendering. Region
pinning is available on Hobby (single region), so this costs nothing. Create the
Supabase project in Mumbai too — the pin is pointless otherwise.

---

## 1. The production Supabase project

The currently linked project holds development residue and should stay as dev.

1. Create a new project. **Region: Mumbai (`ap-south-1`)** — it must match
   `bom1`, or §0's third decision is undone.
2. Link and push. All 40 migrations are forward-only and the reference data
   (commission slabs, tax rates, fee schedule, categories, platform settings,
   admin roles) is itself migration `20260812091700_seed_reference_data.sql`,
   so a `db push` leaves the project able to price a job. There is no separate
   seed step.

```bash
npx supabase link --project-ref <new-project-ref>
```

```bash
npx supabase db push
```

3. Lint it. This is the gate CLAUDE.md insists on after anything that writes
   money, and it catches the ambiguous-column class of bug that `db push`
   accepts happily and that only fails at runtime, on the money path.

```bash
npx supabase db lint --linked --level warning
```

4. Grant yourself the console. `admin_users` has RLS on and no policies at all,
   so there is deliberately no API path to it — this runs in the Supabase SQL
   editor, against the new project, after you have signed up through the
   deployed site in §5.

```sql
insert into public.admin_users (profile_id, role_id)
select p.id, r.id
from public.profiles p, public.admin_roles r
where p.email = 'you@example.com' and r.code = 'super_admin';
```

5. Regenerate types if you want them to match the new ref. **From Git Bash, not
   PowerShell** — PowerShell's `>` writes UTF-16LE with CRLF and turns the
   generated file into an unreadable diff.

```bash
npx supabase gen types typescript --project-id <new-project-ref> > src/types/database.types.ts
```

---

## 2. Environment variables

**Set these before the first deploy, not after.** The five `NEXT_PUBLIC_*` ones
are inlined into the browser bundle at build time — adding them to a project
that has already built leaves the old values baked into the served JavaScript
until you redeploy. The server-only ones are read per request and would take
effect on the next invocation, but there is no reason to split the work.

Vercel → Project → Settings → Environment Variables. Scope them to
**Production** (and Preview, if you want previews to function).

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | New project → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page. Bypasses RLS — server only, never `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SITE_URL` | Your production origin, e.g. `https://zevi.in`. **See the note below** |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Razorpay → Account & Settings → API Keys |
| `RAZORPAY_KEY_SECRET` | Same page. Server only |
| `RAZORPAY_WEBHOOK_SECRET` | You choose it when creating the webhook in §5.2 |
| `RAZORPAY_X_ACCOUNT_NUMBER` | RazorpayX → Account Statement. The platform's own account |
| `KYC_HASH_PEPPER` | `openssl rand -hex 32`. Changing it later orphans every existing PAN/account hash |
| `RAZORPAY_PAN_VERIFY_URL` | Optional. Arrives with the Razorpay contract; without it KYC still completes under the ₹5,000 lifetime line |
| `CRON_SECRET` | `openssl rand -hex 32`. Also goes into the external scheduler in §6 |
| `SES_REGION` | `ap-south-1` |
| `SES_ACCESS_KEY_ID` | IAM user holding `ses:SendEmail` and nothing else |
| `SES_SECRET_ACCESS_KEY` | Same user |
| `SES_FROM_ADDRESS` | A verified identity, e.g. `Zevi <no-reply@zevi.in>` |
| `SES_REPLY_TO_ADDRESS` | Optional |
| `SES_CONFIGURATION_SET` | From `node scripts/ses-domain.ts notifications …` |
| `SES_SNS_TOPIC_ARN` | The SNS topic. `/api/webhooks/ses` 503s while unset |
| `MSG91_AUTH_KEY` | MSG91 → Settings → API Keys. Full account access — treat it like the Razorpay secret |
| `MSG91_SENDER_ID` | The DLT-approved transactional header, e.g. `ZEVIIN`. See [sms-setup.md](sms-setup.md) §2 |
| `MSG91_OTP_TEMPLATE_ID` | MSG91 → Templates, once DLT has approved the text. [sms-setup.md](sms-setup.md) §4 |

`SES_*` and not `AWS_*` on purpose: a Vercel function runs on Lambda, whose
runtime sets `AWS_REGION` and both `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
for its own execution role, and ours would be shadowed in some contexts and not
others.

### `NEXT_PUBLIC_SITE_URL` is not optional in production

`getSiteUrl()` falls back to `VERCEL_URL`, which is the **deployment-specific**
hostname (`zevi-a1b2c3-param.vercel.app`) and changes on every single push. It
is what builds the links in Supabase's confirmation and recovery emails. Leave
this unset and every password-reset link points at a one-off deployment URL that
will not be on the redirect allow list — the reset silently lands on the Site
URL instead and the user cannot get in. Set it to the stable production origin.

---

## 3. First deploy

Import `param159357/zevi` at [vercel.com/new](https://vercel.com/new). Next.js
is detected; the defaults are right. `vercel.json` supplies the region and the
one cron.

Verified locally before writing this: `npm run build` succeeds, `npx tsc
--noEmit` is clean, and all 324 tests pass.

`/dev/emails` is prerendered as a 404 in production by the `(dev)` layout's
`NODE_ENV` check — it is in the build output but is not a live route.

---

## 4. Domain

Vercel → Settings → Domains. Point the apex at Vercel's A record and `www` at
the CNAME, per the instructions the dashboard gives for your registrar.

Do this **before** §5: all three of those integrations are configured with a URL
that has to be the final one, and redoing them is the only cost of getting the
order wrong.

Note for Cloudflare, which the stack table names: the DNS records must be **DNS
only** (grey cloud), not proxied. A proxied record in front of Vercel breaks
certificate issuance.

---

## 5. The three things that need the live origin

Everything here is a callback into the deployed site, so none of it can be done
before §4.

### 5.1 Supabase redirect URLs

Dashboard → Authentication → URL Configuration.

- **Site URL**: `https://zevi.in`
- **Redirect URLs**: add `https://zevi.in/**`

Without the wildcard entry Supabase drops the confirmation code on the Site URL
instead of `/auth/callback`, and both email confirmation and password recovery
break — recovery the more quietly of the two.

### 5.2 Razorpay webhook

Dashboard → Settings → Webhooks → Add New Webhook.

- **URL**: `https://zevi.in/api/webhooks/razorpay`
- **Secret**: whatever you put in `RAZORPAY_WEBHOOK_SECRET`
- **Events**: `payment.captured` and `payment.failed`

This is the backstop for a client who paid and then closed the tab. Without it
that job is charged for and never assigned. The route refuses every delivery
while the secret is unset rather than trusting an unsigned body.

Going live also means **live** Razorpay keys (`rzp_live_…`), which requires
Razorpay account activation. Test keys will not charge a real card.

### 5.3 SES

Full runbook in [email-setup.md](email-setup.md). The parts that matter here:

```bash
node scripts/ses-domain.ts setup zevi.in
```

Publish the DNS records it prints, then subscribe the SNS topic to
`https://zevi.in/api/webhooks/ses`.

**You must leave the SES sandbox** before launch. Inside it, SES delivers only
to verified addresses — every real user's confirmation email is accepted by the
API and silently never arrives, which is exactly spec §15's failure mode. It is
a support request and takes a day or so.

---

## 6. The external scheduler

Three endpoints, all `GET`, all authenticated by
`Authorization: Bearer $CRON_SECRET`.

| Endpoint | Interval | What waits on it |
|---|---|---|
| `/api/cron/auto-accept` | hourly | Deliveries completing; spec §5's reminders |
| `/api/cron/email` | every 10 min | Every queued email |
| `/api/cron/refunds` | every 15 min | Money going back to clients |

`/api/cron/payouts` stays on Vercel Cron — it is daily, so Hobby accepts it. Its
schedule is `30 19 * * *` UTC = 01:00 IST. Hobby has ±59 minutes of scheduling
jitter, which is harmless here: the cutoff is 18:30 UTC and `build_payout_batch()`
refuses a cutoff that has not arrived, so a late run is a late batch and never an
early payment.

### Option A — cron-job.org

Free, one-minute resolution, and supports custom request headers. Create three
jobs with the URLs and intervals above; under each job's **Headers**, add
`Authorization` = `Bearer <your CRON_SECRET>`. Enable failure notifications.

The tradeoff is honest: a third party holds a token that completes jobs and
releases escrow. If that is not acceptable, use Option B.

### Option B — Supabase `pg_cron` + `pg_net`

Keeps the secret inside infrastructure you already run, and cannot be disabled
for inactivity. Both extensions are available on Supabase including the free
plan. In the SQL editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('zevi-auto-accept', '0 * * * *', $$
  select net.http_get(
    url := 'https://zevi.in/api/cron/auto-accept',
    headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
  );
$$);

select cron.schedule('zevi-email', '*/10 * * * *', $$
  select net.http_get(
    url := 'https://zevi.in/api/cron/email',
    headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
  );
$$);

select cron.schedule('zevi-refunds', '*/15 * * * *', $$
  select net.http_get(
    url := 'https://zevi.in/api/cron/refunds',
    headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
  );
$$);
```

`net.http_get` is fire-and-forget; responses land in `net._http_response`, which
is where to look when a sweep appears not to have run.

Whichever option, **verify each one fires at least once** before trusting it.
The failure mode is silent: an auto-accept sweep that never runs looks exactly
like a platform with no deliveries pending.

---

## 7. Verification

Reaching a 401 is the goal — it proves the route is live and the token check is
running. A 200 here would mean an open endpoint that releases escrow.

```bash
curl -i https://zevi.in/api/cron/auto-accept
```

Then with the real token:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://zevi.in/api/cron/payouts
```

Also confirm: `/dev/emails` returns 404; signup sends a confirmation email whose
link lands on `https://zevi.in/auth/callback` and not a deployment URL; and the
Vercel function logs show `bom1` as the execution region.

---

## 8. What is deliberately not wired

None of these blocks a deployment; all of them are things that will look broken
if you expect them to work.

- **Money cannot reach a worker.** The payout batch assembles and stops. There
  is no disbursement step, so `payouts` rows never become bank transfers. This
  is the single largest gap in the platform, deployed or not.
- **SMS is wired but needs DLT approval**, which is the one item on this list
  with a lead time rather than a code gap. See the callout at the top of this
  file and [sms-setup.md](sms-setup.md).
- **Sentry is unwired.** `SENTRY_DSN` is listed in `.env.example` and read by
  nothing. Vercel's own function logs are the only error surface.
- **Uploads are in Supabase Storage, not R2.** Works; watch the storage quota
  on whichever Supabase plan the new project is on.
- **Razorpay Route transfers are not wired.** Escrow is held on the platform
  account with `escrow_holds` and the ledger as the record of whose it is.
- **A failed refund has no console screen.** `refunds_failed_idx` makes the pile
  visible in SQL and the cron logs at error level every run.
