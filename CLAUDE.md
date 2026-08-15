# CLAUDE.md

Working notes for Zevi. Read [SPEC.md](SPEC.md) for what the product is and why;
this file covers how the code is built.

**Status: a job runs end to end, and a verified worker can now be paid.**
The app scaffold, Supabase clients, folder structure and the full database schema
are in place and pushed. Signup and login work end to end for both sides — email
verified through Supabase, mobile through our own OTP. A client can post a job:
category tiles, brief, attachments, budget and deadline, autosaved as a draft and
published through `publish_job()`. A worker can add 3–6 samples per category with
captions and submit them, and an admin can approve, flag or reject from the
console queue. An approved worker sees the category-filtered feed, reads a brief
and opts in with the three short fields. The client reads that list, sorted by
rating, with each worker's samples beside their three answers, and picks one
— which charges their card through Razorpay, holds the budget in escrow and
writes the ledger entries, in the same transaction that assigns the job. The
worker then delivers: files upload straight to storage, images and PDFs get a
real watermarked derivative, and the client accepts, asks for the one free
revision, or says nothing and lets the clock accept it for them. Acceptance
releases escrow, recognises the worker's half of the commission and opens a
`worker_earnings` row.

On top of that the twice-weekly cycle runs: holds expire on their own, a batch
closes Wednesday and Sunday midnight IST, and every matured unheld earning is
gathered into one payout per worker. A worker sees their balances and the date
they will be paid.

And a worker can now prove who they are. KYC takes a name, a date of birth, a
PAN and a bank account or UPI id, sends ₹1 through Razorpay's penny drop to
learn whose name is really on the account, compares that with the PAN registry's
and with what they typed, and blocks — permanently, with no override — when they
disagree. A pass writes a verified `payout_methods` row, which is exactly what
`build_payout_batch()` has been skipping every worker for want of. Three failed
attempts and a duplicate PAN both land in a new console queue.

And the console is now the five modules spec §7 describes rather than two. Home
is a real work queue ordered by what is rotting; disputes have a queue and a
one-screen case with the three outcomes behind it; users can be searched, read
whole and warned, suspended or banned; payout batches can be reviewed before a
run and failed payouts returned to the next cycle.

Nothing beyond that: no chat, no ratings — and **money still cannot leave the
platform account**. The batch assembles and stops: the disbursement step that
turns a `payouts` row into a bank transfer, writes `payout_paid` to the ledger
and handles a failure is not built. That is still the single thing standing
between this and a worker holding the money, and it is now also what stands
between a decided dispute and a client's refund: `resolve_dispute()` moves the
worker's share through the ledger and leaves the client's as a `pending` refund
row, because Razorpay's refund API is unwired too. **Nothing raises a dispute
yet** — spec §4's step 8 gives the client accept, revise or dispute and only the
first two are built — so the queue is correct and empty. SES, Sentry and SMS are
unwired, and uploads sit in Supabase Storage until R2 replaces it.

---

## Commands

```bash
npm run dev      # dev server on :3000 (Turbopack)
npm run build    # production build
npm run start    # serve the production build
npm run lint     # eslint
npm test         # vitest — commission, payment signatures, payout calendar, KYC names
npx tsc --noEmit # typecheck — CI gate, run before calling anything done

npx supabase db push   # apply new migrations to the linked project
npx supabase gen types typescript --project-id vsqqrbodwrvjuclqhean > src/types/database.types.ts

# The auto-accept sweep. Vercel Cron calls this hourly in production; nothing
# calls it locally, so a delivery past its window sits there until you do.
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/auto-accept

# The payout run — expires matured holds, then builds the batch for whichever
# cycle closed most recently. Daily at 01:00 IST in production. Idempotent: on
# the five days a week with nothing new to close it finds the batch already
# built and says so.
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/payouts

# plpgsql_check against the linked project. Run it after any new function that
# writes money — it catches the ambiguous-column class of bug that `db push`
# accepts happily and that only fails at runtime, on the money path. See 0032.
npx supabase db lint --linked --level warning
```

**The terminal here is PowerShell** (Windows PowerShell 5.1). Chain commands with
`;`, never `&&` or `||` — those are parser errors, not just unsupported. No
`head`, `tail`, `which` or `touch` either: use `Select-Object -First` / `-Last`,
`Get-Command`, `New-Item`.

One exception, and it matters: **regenerate the Supabase types from Git Bash.**
PowerShell's `>` writes UTF-16LE with CRLF, which fights `.gitattributes` and
turns a 5,000-line generated file into an unreadable diff. If it happens anyway:

```bash
iconv -f UTF-16 -t UTF-8 src/types/database.types.ts | tr -d '\r' > /tmp/t
cp /tmp/t src/types/database.types.ts
```

Copy `.env.example` to `.env.local` before the first run. The app throws a named
error on a missing variable rather than failing obscurely.

**A function that returns one row, not a set**, gets a `SetofOptions` block in
the generated types with `isSetofReturn: false` — `open_job_payment`,
`settle_job_payment_and_assign` and `fail_job_payment` all do. That is the tell
that PostgREST hands back the composite directly, so **do not chain
`.single()`** on those calls; the result type collapses to `never` if you do.
`publish_job` and `slab_for` are the other shape, and their `Returns` is an
array.

The generator also types an optional argument as `p_actor_id?: string`, never
`string | null`. To pass "no value", omit the key — `...(actorId ? { p_actor_id:
actorId } : {})` — and let the function's own `default null` apply.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) | Server Components by default |
| Language | TypeScript (strict) | |
| UI | React 19 | |
| Styling | Tailwind CSS v4 | CSS-first config in `globals.css`, no `tailwind.config.js` |
| DB + Auth | Supabase (Postgres) | `@supabase/supabase-js`, `@supabase/ssr` |
| Files | Cloudflare R2 | not wired up |
| Watermarks | `sharp` (raster) · `pdf-lib` (PDF) | delivery previews, generated server-side |
| Payments | Razorpay | charge + escrow wired; Route transfers need KYC |
| Email | Amazon SES | not wired up |
| Errors | Sentry | not wired up |
| Hosting | Vercel + Cloudflare | |

Tailwind v4 has no config file by design — theme tokens live in `@theme` inside
[src/app/globals.css](src/app/globals.css). Don't add `tailwind.config.js`.

---

## Folder structure

```
src/
├── app/
│   ├── (marketing)/     public pages — landing, legal, category browse
│   ├── (auth)/          signup, login, the two verification steps
│   ├── (client)/        job posters: post, shortlist, review, dashboard
│   ├── (worker)/        workers: feed, opt-in, deliver, earnings, KYC
│   ├── (admin)/         work queue: approvals, KYC, disputes, payouts, users
│   ├── auth/callback/   where the email confirmation link lands
│   ├── api/             route handlers — webhooks (Razorpay), cron, uploads
│   ├── layout.tsx       root layout
│   └── globals.css      Tailwind entry + theme tokens
├── components/
│   ├── ui/              generic primitives: Button, TextField, TextArea, Alert
│   └── <feature>/       feature-scoped components, colocated by domain
├── lib/
│   ├── supabase/        client.ts (browser) · server.ts (server) · middleware.ts
│   ├── auth/            session.ts (who is signed in) · actions.ts · types.ts
│   ├── jobs/            actions.ts · queries.ts · validation.ts · types.ts
│   ├── workers/         samples and the application: actions · queries · types
│   ├── matching/        feed, opt-ins, shortlist: actions · queries · shortlist · validation · types
│   ├── deliveries/      delivery, acceptance, revisions: actions · queries · access · preview · validation · types
│   ├── admin/           the console (spec §7): session · types · queries and
│   │                    actions for approvals and KYC · queue (home) ·
│   │                    disputes · users · payouts · decisions (the four
│   │                    money-and-account actions 0034 added)
│   ├── money/           commission.ts (the calculator) · rates.ts (lookup)
│   ├── payments/        Razorpay: actions · settle · razorpay · signature · quote
│   ├── payouts/         the twice-weekly cycle: cycle · eligibility · queries · types
│   ├── kyc/             identity before the first payout: actions · queries · razorpay · names · hash · validation · types
│   ├── uploads/         client.ts (browser hashing, object naming) · sign.ts (service-role signed URLs)
│   ├── sms/             OTP delivery seam — no provider wired yet
│   ├── constants/       commission slabs, deadline caps, fee amounts, limits
│   ├── utils/           pure helpers only
│   └── env.ts           validated environment access
├── hooks/               shared React hooks
├── types/               database.types.ts (generated) + shared domain types
└── middleware.ts        session refresh + signed-in-only redirects

supabase/
└── migrations/          SQL migrations, checked in, forward-only
```

Route groups `(client)` / `(worker)` / `(admin)` are URL-invisible — they exist
to separate layouts and auth boundaries, not to add path segments.

---

## Naming: "client" is overloaded

- **Client** (capital C, domain) = the person posting and paying for a job.
- **Client Component** = React `"use client"`. Always write both words.
- **Worker** = the person doing the job. Never means a Web Worker or Edge
  Worker; say "Cloudflare Worker" in full if that ever comes up.

When ambiguity is possible in code, prefer `clientUser` / `workerUser` over bare
`client`, which reads as a Supabase client.

---

## Supabase

Three factories, three jobs — pick deliberately:

| Use | Import | Runs as |
|---|---|---|
| Client Components | `@/lib/supabase/client` | signed-in user, RLS enforced |
| Server Components, Actions, Route Handlers | `@/lib/supabase/server` | signed-in user, RLS enforced |
| Webhooks, payouts, background jobs | `createServiceRoleClient` from `@/lib/supabase/server` | **bypasses RLS** |

Rules:

- **RLS on every table, no exceptions.** A table without a policy is a data leak
  waiting for its first bug. Write the policy in the same migration as the table.
- The service-role key never reaches the browser. It is only read in server
  files, only through `serverEnv`.
- Never reach for the service-role client to work around a policy that's
  inconvenient — fix the policy.
- Create the server client per request. Module-level singletons leak one user's
  session into another's request.
- Migrations are checked in and forward-only. No editing an applied migration.
- **Index every column that gets filtered or sorted**, from the first migration.
  The spec treats this as correctness, not optimisation.
- Job assignment takes a database-level lock. Double-assignment is the one race
  that costs real money.
- **Grants are not inherited any more.** This project's default privileges give
  `anon`/`authenticated`/`service_role` no SELECT, INSERT, UPDATE or DELETE on a
  new table, so a table created without grants is invisible to PostgREST —
  `42501 permission denied`, before RLS is ever consulted. Migration 0020 sets
  `alter default privileges` so this is handled going forward; if a new table
  ever 42501s, that is where to look.

### Schema

35 migrations, 81 tables, RLS on every one. What to know before writing a query:

- **`profiles` is PII and no policy exposes it to another *user*.** What others
  may see lives in `public_profiles` (a trigger-maintained projection),
  `worker_profiles` and `client_profiles`. Private counters live in
  `worker_state` and `user_private_stats` — dispute rate and risk score are
  admin-only *by table*, not by remembering to trim a SELECT list. The one
  exception is staff: 0027 lets `manage_users` read every profile and
  `review_workers` read workers only, because the approval screen exists to
  check a legal name against an ID.
- **Chat splits the same way.** `messages` holds the redacted body both
  participants read; `message_raw` holds the original, admins only.
- **Money is an append-only ledger.** `ledger_transactions` + `ledger_entries`,
  balanced by a deferred constraint trigger. Read balances from
  `ledger_account_balances`. Never add a balance column.
- **Rates are versioned data**: `commission_slabs`, `tax_rates`, `fee_schedule`,
  each with an effective window and an exclusion constraint against overlap.
  Insert a new row to change a rate; never UPDATE one in place.
  `job_financials` freezes a job's price at assignment and cannot be updated.
- **Assignment goes through `claim_job_assignment()`**, which takes
  `SELECT … FOR UPDATE` on the job row. Never INSERT `job_assignments` directly.
  Since 0029 the only caller is `settle_job_payment_and_assign()`, so an
  assignment always has a captured payment and a balanced ledger behind it.
- **Delivery goes the same way** (0030). `submit_job_delivery()`,
  `accept_job_delivery()` and `request_job_revision()` are service-role only, and
  0008's three INSERT policies on `job_deliveries`, `delivery_files` and
  `job_revisions` were dropped with the grants — each of those writes moves a row
  the same statement cannot finish, and acceptance moves money.
- **Cast every enum literal in a function.** 0025, 0026 and 0029 are all the
  same bug: a `case` or a parameter-built `values` row containing bare literals
  resolves to `text`, and Postgres will not coerce text to an enum in
  assignment context — `42804`, at runtime, on a path nobody had reached yet.
  0029 fixed the last two in `claim_job_assignment()`. Write
  `'client'::public.party_role`, always.
- **Know which column positions plpgsql substitutes variables into.** 0032 is
  the same *shape* of bug as those three and catches people who have learned
  only half the rule. Inside a function body an INSERT column list and an UPDATE
  `set` target are **not** substituted, so they are safe unqualified — but an
  ordinary expression is, and so is an `on conflict (col)` inference spec, which
  is the one place a qualification is not syntactically allowed. Qualify every
  expression (`e.status`, `b.total_paise`); for ON CONFLICT, either name a
  constraint or look-then-insert. `supabase db lint --linked` finds all of these
  and `db push` finds none of them.
- **KYC moves in three steps and never in one** (0033).
  `open_worker_kyc_attempt()` counts the attempt *before* a rupee is spent on a
  penny drop, `record_worker_kyc_destination()` holds the destination while the
  bank thinks about it, and `settle_worker_kyc()` applies the outcome to
  `worker_kyc`, `payout_methods` and `worker_state` in one transaction. All four
  functions in 0033 are service-role only. **`blocked` is not `rejected`**: a
  name mismatch is terminal and `review_worker_kyc()` refuses to lift it, which
  is what spec §6's "no override" looks like as code rather than as a policy
  someone remembers.
- **A dispute is decided while its money is still in escrow** (0034).
  `resolve_dispute()` refuses a job whose hold is already released and says so —
  spec §11 lets a client raise one up to 48 hours *after* acceptance, and that
  case needs the worker's earning reversed (`earning_status` has 'reversed' for
  it), which is a flow, not a branch. A full release writes the same four ledger
  legs, for the same amounts off the same frozen `job_financials` row, as
  `accept_job_delivery()` — a release **is** an acceptance, arrived at the slow
  way. Only the worker's share moves through the ledger; the client's becomes a
  `pending` refund, so the escrow account's balance stays equal to what the
  platform actually holds.
- **`profiles.status` is moved by `apply_user_sanction()` and nowhere else**
  (0034). It writes the `user_sanctions` row, the status change and the audit
  row in one transaction, refuses a target who is an active console member, and
  `lift_user_sanction()` returns the account to `active` only when nothing else
  is still holding it down — two overlapping suspensions lifted one at a time
  must not let the first lift undo the second.
- **The full PAN and account number are not in this database.** Only
  `pan_last4` / `account_last4` and a keyed HMAC — `KYC_HASH_PEPPER` lives in the
  environment, so a database copy answers "same PAN?" for nobody but us. Don't
  add a column that stores either in full.
- **Posting goes through `publish_job()`** (0022), the same way: it locks the
  row, decides open vs `pending_moderation`, and writes the moderation and
  classification queue rows in the same transaction. Never move a job out of
  'draft' by hand.
- **Only a draft may be incomplete.** 0022 made `title`, `description` and
  `budget_paise` nullable so autosave can store a half-written brief;
  `jobs_publishable` re-imposes every rule the moment the status is anything but
  'draft'.
- **Worker applications move the same way** (0027):
  `submit_worker_application()` counts samples per category against
  `categories.sample_min` and starts the SLA clock;
  `review_worker_application()` records the decision, stamps the samples and
  writes the audit row in one transaction. UPDATE on `worker_applications` is
  revoked from `authenticated`, so neither is bypassable from a browser.
  `worker_samples_locked()` is what freezes a portfolio while it is in review.
- **An opt-in is written once.** 0028 narrows the worker's UPDATE on
  `job_opt_ins` to `(status, withdrawn_at)`, so the withdrawal the policy allows
  cannot carry a rewritten `noticed_detail` along with it. The five-slot cap and
  both counters are `sync_opt_in_counters()`, which recounts rather than
  increments — read `worker_profiles.active_opt_ins`, never a tally of your own.
- **Append-only, enforced by trigger**: `admin_audit_log`, `job_events`,
  `ledger_*`, `job_financials`. UPDATE and DELETE raise.
- **Tunables live in `platform_settings`**, read via `setting_int()` /
  `setting_bigint()` / `setting_bool()`. Slabs, tax and fees do not — see above.
- Policy helpers: `is_admin()`, `admin_can(perm)`, `is_active_worker()`,
  `is_job_participant()`, `is_job_client()`, `worker_works_in_category()`,
  `is_conversation_participant()`, `is_dispute_party()`,
  `worker_samples_locked()`. Call them as `(select public.is_admin())` inside a
  policy so Postgres evaluates once per statement rather than once per row.

Money-moving writes — acceptance, escrow release, payouts, dispute decisions —
have INSERT/UPDATE revoked from `authenticated` at the table level. They run
server-side with the service-role client, in the same transaction as their
ledger entries. That is not a workaround for a missing policy; it is the policy.

---

## Auth

Spec §5 and §6 both open the same way: email and mobile, both compulsory and
both verified. The flow is a four-state machine, resolved in one place by
`resolveStep()` in [src/lib/auth/session.ts](src/lib/auth/session.ts):

```
verify_email → verify_mobile → choose_role → complete
```

- **Email** is Supabase Auth's. `signUp` sends the confirmation link,
  `/auth/callback` exchanges the code for a session, and an `auth.users` trigger
  mirrors `email_confirmed_at` into `profiles.email_verified_at`.
- **Mobile** is ours, because SES sends email only. `request_phone_verification()`
  stores a bcrypt-hashed OTP and owns the cooldown, hourly cap and attempt cap;
  `verify_phone_otp()` is the only writer of `profiles.mobile_verified_at`. Both
  are service-role only, called from Server Actions.
- **The number is never written before it is proven.** `profiles.mobile` has a
  unique index; writing an unverified number would let anyone squat one.
- `intended_role` lives in auth metadata, which the user can edit, so it decides
  which screen comes next and **never** what an account may do. The role records
  (`client_profiles`, `worker_profiles`) are inserted by the user under RLS.
- Guards in layouts, not just middleware. `requireRole()` re-checks server-side;
  middleware only spares signed-out visitors a wasted render.

Two things still missing, deliberately: **no SMS provider** (development prints
the code to the console, production refuses to send) and **no password reset**.

The project has no custom SMTP either, so Supabase's built-in sender applies its
own low hourly limit — fine for development, not for launch.

---

## Worker onboarding

Spec §6 puts two gates between signing up and seeing a job, far apart in time.
The first is built:

```
categories (max 3) → samples (3–6 each) → submitted → approved · flagged · rejected
```

- **Samples are uploaded straight to storage**, keyed
  `worker-samples/<worker id>/<category id>/<uuid>.<ext>`, then registered by a
  Server Action that re-reads the size and content type from storage. Same shape
  as job attachments; `lib/uploads/client.ts` is the half they share.
- **"Did you make this alone?" is refused, not recorded as false.** The stored
  `true` is what makes a later plagiarism ban defensible (spec §10).
- **Submitting is a one-way door.** `worker_samples_locked()` freezes the
  portfolio the moment an attempt is in review, and again once it is approved. A
  rejection unlocks it for the single resubmission, seven days later.
- **One resubmission, enforced from every rejected attempt**, not just the newest
  row — otherwise inserting a fresh draft would skip the wait.
- Sample review is per *application*, not per sample: the decision stamps every
  pending sample with the same outcome. The per-sample columns exist for the day
  that is not enough.
- Not built yet: the 60-second cap on video samples, and watermarked sample
  previews. The watermarker itself now exists — `lib/deliveries/preview.ts`,
  built for deliveries — so pointing samples at it is a small job whenever the
  shortlist's unwatermarked signed URLs start to matter. Both land with R2. KYC
  is built, and is its own section below — spec §6 puts it before the first
  payout, not here.

### The console

`/admin` is a work queue (spec §7), and home is the work queue itself rather
than a redirect: five counts, each with the deadline closest to breaching, and
**the sort key is the deadline, not the count**. Forty approvals with eighteen
hours left is a calmer morning than one dispute four days into a five-day clock.

Five modules, and the two that count without linking anywhere say so:

| Module | Route | Permission |
|---|---|---|
| Work queue | `/admin` | membership |
| Disputes | `/admin/disputes` | `view_disputes` · `resolve_disputes` to decide |
| Worker approvals | `/admin/approvals` | `review_workers` |
| Users | `/admin/users` | `manage_users` |
| Payouts | `/admin/payouts` | `manage_payouts` |
| KYC review | `/admin/kyc` | `manage_payouts` |

Expiring jobs and flagged reports are **counted on the home screen and link
nowhere**, because spec §16 puts a job list and a reports module in V1 and
neither is built. A number with no door beats a tab that 404s, and beats silence
by more — an unread abuse report is the thing this screen exists to stop being
invisible.

The layout guard is **membership** (`requireAnyAdmin`), not one permission. It
used to be `review_workers`, which was indistinguishable from correct while
approvals was the only module and locked the seeded `finance` role out of the
whole console the moment KYC review landed. Each page still names the permission
it needs, and `AdminNav` only renders a tab the account can actually open.

Access is checked three times, deliberately not the same check three times:
`requireAdmin(perm)` decides what renders (and 404s everyone else rather than
admitting the route exists), the `admin_can(...)` policies decide what the
queries return, and every decision function — `review_worker_application()`,
`review_worker_kyc()`, `resolve_dispute()`, `apply_user_sanction()`,
`lift_user_sanction()`, `review_payout_batch()`, `retry_failed_payout()` — looks
the permission up again from the actor's id, because under the service-role key
`auth.uid()` is null and `admin_can()` would answer false for a super admin.

**When a console screen cannot read something, widen the policy.** 0035 is the
worked example: a `support` account holds `resolve_disputes` and neither
`view_finance` nor `manage_users`, so the dispute screen could show both
statements, the whole chat and every file — and not the amount it was asking
someone to divide. The fix was `view_disputes` on `escrow_holds` and
`job_financials`, not a service-role read in the query module. The same
migration adds `is_admin_account(uuid)`, because `admin_users` has RLS on and no
policies at all: a direct SELECT comes back empty even for a super admin, so the
user screen would have cheerfully offered to ban a colleague.

**Admin membership is granted out of band.** `admin_users` has RLS on and no
policies at all, so there is no API path to it — run this in the Supabase SQL
editor:

```sql
insert into public.admin_users (profile_id, role_id)
select p.id, r.id
from public.profiles p, public.admin_roles r
where p.email = 'you@example.com' and r.code = 'super_admin';
```

`admin_roles` also ships `support`, `reviewer` and `finance` (0018). Every
decision writes to `admin_audit_log`, which is append-only by trigger — a row
there can never be edited or deleted, including by the service-role key.

---

## The feed and opting in

Spec §6's second half, and the first screen an approved worker uses every day.

- **The feed is filtered by RLS, not by the query.** `approved workers read the
  open feed` (0006) is what limits `jobs` to open rows in a category the worker
  works in; the `.eq`/`.in` in `loadWorkerFeed` are there for `jobs_feed_idx` and
  for readability. The category tabs are links, so `/worker/jobs` ships no
  route-specific JavaScript at all.
- **A card's client half comes from `client_profiles` and `public_profiles`.**
  `jobs.client_id` points at `profiles`, so there is no FK to embed along — and
  there should not be. Two explicit reads of the two public projections instead.
- **The three short fields are one budget.** 300 characters across all of them
  (`job_opt_ins_total_length`), which is why `parseOptInFields` checks them
  together and the form shows one running count rather than three.
- **The dwell timer is friction, not a gate.** `brief_opened_at` is stamped by
  the server that rendered the brief and posted back by the browser, so a worker
  who edits the payload can shorten their own wait — 0007 says as much, and
  stores the column so the pattern is visible in the data. Closing it needs a
  signed token or a server-side record of the page view. Neither exists yet.
- **The five-slot cap is read, not assumed.** `worker_state.opt_in_limit_override`
  beats `platform_settings.matching.max_active_opt_ins` for one worker, exactly
  as `sync_opt_in_counters()` decides it. The pre-check in `optIntoJob()` exists
  for the sentence; the trigger is the limit.
- Withdrawal is offered on an `active` opt-in only. The policy allows it while
  shortlisted too, but a worker vanishing from a list a client is mid-decision on
  is a behaviour spec §6 has penalties for and no rule about — so it waits for one.
- A worker cannot see a job's attachments before assignment —
  `job_attachments` follows `is_job_participant`, deliberately.

---

## The shortlist and picking

Spec §5's other half, and the moment the job stops being a posting.

- **There is no shortlist algorithm, and that is the spec's own decision.** §5
  describes five slots — one top-rated, three AI-ranked, one newest — and §16
  cuts it in one line: "AI ranking of middle 3 → show all opted-in workers
  sorted by rating." So `/shortlist/[jobId]` lists *every* opted-in worker, best
  first, and nothing is written to `job_shortlists` / `job_shortlist_entries`.
  Those tables record which five a client was shown and why, which is evidence
  worth keeping the day there is a ranking to record and noise before it.
  `rank_score`, `note_score` and the `shortlist_slot` enum stay unread.
- **The sort key is the rating in *this job's* category.** §6 keeps ratings
  per (worker, category) so 4.9 at decks and 3.2 at video never blend, so
  `worker_category_stats` wins and `worker_profiles.rating` is the fallback —
  labelled either way, because the two say different things. Under it: jobs
  completed, then the opt-in's own timestamp, so at launch (every rating null)
  the list is still ordered by something a client can act on.
- **A client never touches `profiles`.** The name is `public_profiles.display_name`
  — a first name, not the legal name on the ID — and the stats come from
  `worker_profiles` and `worker_category_stats`, the tables that exist to be
  read by someone else.
- **Samples are signed with the service-role key, after the guard.** No policy
  hands a client another user's `files` row and none should: 0004 calls file
  access "a decision, not a row predicate". So `lib/uploads/sign.ts` mints the
  URLs — shared with the approval queue, which has the same shape — and only for
  keys the client's own RLS-scoped query returned. Approved samples only, in the
  job's category only.
- **Picking is paying**, so it lives in `lib/payments/`, not `lib/matching/`.
  See the section below.
- Not built yet: the client cannot cancel or unassign from this screen, and
  nothing notifies the worker they were picked (`shortlist_ready` and the rest
  of `notification_type` are still unused).

---

## Payment at selection

Spec §4, step 5: "client picks one, payment happens here, into escrow." One
moment, four things that must all happen or none of them.

```
startJobPayment()   price → freeze → open order      (nothing charged yet)
   ↓ Razorpay Checkout, in the client's browser
confirmJobPayment() verify → fetch → capture → settle
   ↓                                     ↑
/api/webhooks/razorpay ──────────────────┘   the backstop for a closed tab
```

- **The browser decides nothing.** It names a payment row, a Razorpay payment
  id and a signature. The order id is read from *our* row (so a valid signature
  for someone else's order proves nothing), the amount is recomputed from the
  job, and the worker comes off the opt-in the payment was raised against —
  all written before a payment form was shown.
- **Settlement is one database transaction.** `settle_job_payment_and_assign()`
  flips the payment to captured, opens the escrow hold, writes the balanced
  `payment_captured` ledger transaction and calls `claim_job_assignment()`
  under the same row lock. A captured payment with no assignment is a client
  charged for nothing; an assignment with no ledger entries is a worker owed
  money nobody can account for. Neither is representable.
- **It takes no amounts.** Every figure comes from rows only server-side code
  wrote — `job_financials` for the frozen price, `payments` for the gateway's
  real cut. There is no number in its signature to get wrong or to lie about.
- **Selection moved to the service-role side**, reversing the note this file
  used to carry about `claim_job_assignment` running under the client's own
  key. It is a money-moving write now, and this schema already has a rule for
  those (see the Supabase section). The acting client is passed as
  `p_actor_id`, checked against `jobs.client_id` under the lock, and recorded
  on the `job.paid` event — they are still who did it, just not who executes it.
- **Idempotent on purpose.** The browser and the `payment.captured` webhook both
  settle by the same path, in either order; `ledger_transactions.idempotency_key`
  is what makes the second one harmless. That is what the column is for.
- **Escrow holds the budget, not the client's total.** The client's commission
  and GST are recognised at capture because they are earned then; the worker's
  own share is still inside escrow and comes out at release. So spec §8's "Zevi
  gross" is realised across two moments, and only the first one exists.
- **Lock order is jobs, then payments**, in all three functions. Two that
  disagree deadlock the first time a client reloads checkout while a webhook
  lands.
- **Razorpay Route's transfer half is not wired**, and is not stubbed to look
  wired. Transfers go to *linked accounts* — Razorpay's sub-merchant onboarding,
  a different thing from the contact and fund account KYC creates, which is
  where a payout is *sent*. So the money is captured into the platform account
  and held there, with `escrow_holds` and the ledger as the record of whose it
  is — the same position an `on_hold` Route transfer leaves it in, minus the
  linked account. `transferForJob()` in `lib/payments/razorpay.ts` is the seam,
  and it throws.
- **Escrow release exists now** (0030, below); payouts and refunds still do not.
  If settlement fails after capture the client is charged and unassigned; the UI
  says so and refuses to offer a retry, and the log has the payment id. Building
  refunds is what closes that.
- Without `NEXT_PUBLIC_RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` the shortlist
  disables picking and says why. There is deliberately no assign-without-paying
  path left, in any environment.

---

## Delivery, acceptance and the clock

Spec §4 steps 7–9, and the second half of the money 0029 started.

```
submit_job_delivery()   worker sends       job → delivered, 36h/3d clock starts
   ↓
accept_job_delivery()   client accepts     escrow → worker, job → completed
   ↑                    …or the clock does
sweep_auto_accepts()    /api/cron/auto-accept, hourly
   ·
request_job_revision()  the one free one   job → revision_requested, clock stops
```

- **Acceptance is one transaction and it is the other half of spec §8's gross.**
  Capture recognised the *client's* commission because that is earned then;
  release recognises the *worker's*, opens the escrow hold, writes the balanced
  `escrow_released` ledger transaction, creates the `worker_earnings` row,
  completes the job and the assignment, unlocks the files and moves the
  `jobs_completed` counters. All of it or none of it. It takes no amounts —
  every figure comes from `job_financials`, frozen before a card was charged.
- **`worker_category_stats` is written here and nowhere else.** The shortlist
  sorts on it (spec §6 keeps ratings and experience per category), so a
  completion that skipped it would leave every worker reading "0 jobs" forever.
- **Auto-acceptance is the same function as a click**, with `p_auto` set. There
  is no second implementation of "this job is done" to drift. The sweep gives
  each delivery its own subtransaction and returns its failures as rows, so one
  stuck job does not strand the ones behind it.
- **The window is stored, never re-derived.** `stamp_auto_accept_deadline()`
  reads the three `delivery.auto_accept_*` settings once, at delivery. A client
  promised 36 hours gets 36 hours even if the setting moves an hour later — and
  `request_job_revision()` refuses past it, because the window binds both sides.
- **`delivery_files.unlocked_at` is the whole access model.** Before it the
  client gets a watermarked derivative or nothing; after it, the original.
  `deliveryFileAccess()` is the only place that decides, and every way it can be
  wrong ends with the client seeing *less*. A file whose watermarking failed is
  locked, not shown.
- **The watermark is a separate object under `delivery-previews/`**, which no
  storage policy covers — service-role writes, signed-URL reads. A worker who
  could overwrite their own preview could hand over the clean file early. It is
  generated at file registration, not at submit, so the cost is one file at a
  time while the worker is still assembling.
- **What can honestly be watermarked**: raster images (sharp — downscaled, mark
  composited into the pixels) and PDFs (pdf-lib — stamped on every page). The
  PDF one is weaker and the code says so: the mark is an overlay in the content
  stream and can be stripped. Video needs ffmpeg and PPTX/DOCX need a converter,
  so **they are locked, not faked** — the composer tells the worker their client
  will be deciding blind and asks for a PDF export alongside the source. Text
  and CSV get spec §6's other half: the body inline, no URL minted at all.
- **One free revision, and the second is refused rather than half-built.** Spec
  §5 gives it "only by worker agreement, otherwise dispute", and neither the
  agreement flow nor disputes exist. `job_revisions.due_at` stays null for the
  same reason — the spec sets no revision turnaround, and inventing one invents
  a lateness penalty with it.
- **Reminders are not built.** Spec §5 wants nudges at 12h/30h and 24h/60h;
  there is no email provider, so `reminder_1_sent_at` and `reminder_2_sent_at`
  stay null rather than being stamped for a message nobody sent.
- The earning lands `confirmed`, or `on_hold` for a new client's first three
  jobs (spec §6's chargeback window). What moves it from there is the cycle
  below.

---

## The payout cycle

Spec §6 "Payouts", and the third moment of the money 0029 and 0030 built.

```
release_matured_earning_holds()   the 14 days expiring        on_hold → confirmed
build_payout_batch(cutoff)        the cycle, assembled        confirmed → in_payout
cancel_payout_batch(id, …)        the way back
        ·
/api/cron/payouts                 daily at 01:00 IST
```

- **"Closes Wednesday midnight" is the midnight that *ends* Wednesday.** That is
  the one ambiguous sentence in the spec and everything follows from it: the
  cutoff instants are **Thursday 00:00 IST** (pays Friday) and **Monday 00:00
  IST** (pays Tuesday), so work accepted during Wednesday is in Friday's run.
  The other reading would mean nothing happening on Wednesday counted toward the
  cycle closing on Wednesday.
- **The calendar is in TypeScript, and only there.** `lib/payouts/cycle.ts` is a
  pure function of the clock with no rows to lock, two screens need it before
  any batch exists, and it is where the test runner can reach it —
  `eligibility.test.ts` is the spec's three paragraphs checked against a real
  fortnight. What the database keeps is the *invariant*: `build_payout_batch()`
  refuses a cutoff that is not midnight IST on a Thursday or a Monday, and
  refuses one that has not arrived. A shape check on the calendar's output, not
  a second copy of it — so a compromised cron cannot pay anyone early.
- **Neither delay is ever recomputed.** `eligible_at` (acceptance + 48h) and
  `hold_until` (14 days, a new client's first three jobs) are stamped by
  `accept_job_delivery()` at acceptance. A worker told "Friday" is paid Friday
  even if the settings move on Thursday.
- **The batch selects everything mature, not everything mature *since* the last
  run.** There is no lower bound on `eligible_at` in that predicate, and that
  omission is what makes spec §6's "anything short rolls forward" need no
  special case at all — and what makes a cron that failed for a week pay late
  rather than pay short.
- **Money does not move here, and no ledger entry is written.** Nothing has left
  `worker_payable`, so the ledger saying the platform still owes it is exactly
  right. `payout_paid` and `payout_failed` are already in `ledger_txn_kind` for
  the disbursement step. Not writing them early is also what makes
  `cancel_payout_batch()` cheap — nothing moved, so nothing must be moved back.
- **KYC is what fills a batch, and 0033 did not touch 0031 to do it.**
  `payouts.payout_method_id` is NOT NULL, so the builder skips any worker with
  no verified `payout_methods` row, counts them, and leaves their earnings
  `confirmed` for the next cycle — `workers_skipped` and `skipped_paise` are
  what the cron logs. That was every worker until KYC existed and is now only
  the ones who have not been through it, with no change to the builder at all.
- The batch's resting state is `closed` — assembled, awaiting spec §7's review.
  `under_review` and `processing` belong to the disbursement step. Hitting the
  per-run worker cap leaves it `open` instead, and the next run keeps filling it.
- `cancel_payout_batch()` ships with the builder rather than with disbursement
  because a batch that cannot be un-built is a trap: its earnings sit at
  `in_payout`, invisible to every later cycle. It is lint-clean but has not been
  exercised at runtime — doing so would leave a permanently misleading `failed`
  batch in what is an audit trail.

---

## KYC

Spec §6, "KYC — before first payout, not at signup", and the thing that was
standing between the payout cycle and a worker's bank account.

```
open_worker_kyc_attempt()        the claim, and the attempt counted
   ↓                             (before a rupee is spent — see below)
verifyPan()                      synchronous; a mismatch blocks here
   ↓
createFundAccountValidation()    the ₹1 penny drop, asynchronous
   ↓
record_worker_kyc_destination()  the destination, held `verifying`
   ↓
settle_worker_kyc()              verified · blocked · failed
```

- **The attempt is spent first, not last.** A penny drop costs real money (spec
  §6 budgets ₹3–5 per worker) and spec §6's three-attempt ceiling exists to
  bound that. A ceiling incremented on completion is one you escape by closing
  the tab.
- **The name comparison is the whole rule, and it lives in one pure module.**
  `lib/kyc/names.ts` compares *every* pair among the declared name, the bank's
  and the PAN registry's — including bank against PAN, which is the pair that
  catches an account and a PAN belonging to two different people — and the
  lowest agreement is the score. `names.test.ts` is where the line falls: a
  block is permanent and unappealable, so each pair that must pass is a real way
  Indian names vary (initials, order, honorifics, an extra part on one side,
  SRIRAM against SRI RAM, LAKSHMI against LAXMI) and each that must fail is a
  case where passing means paying a stranger. **RAJESH against RAKESH is one
  edit and two people; MOHAMMED against MOHAMMAD is one edit and one person** —
  that gap is why the token floor is 0.86 and not a round number, and why
  anything looser has to come from a fold rule that names the sound it folds.
- **Razorpay's own `name_match_score` decides nothing.** It is recorded in the
  block reason for the audit trail; our matcher is what the account turns on,
  because it is the one with the tests.
- **The penny drop is asynchronous and the code treats that as normal.**
  Razorpay answers `created`; the bank confirms seconds to minutes later. The
  KYC screen re-reads it once on mount and on a button, and `settle_worker_kyc()`
  is idempotent so two of those racing produce one outcome. A page render never
  settles — `revalidatePath` throws during render.
- **PAN is only mandatory above ₹5,000 lifetime** (spec §6, TDS), counted from
  `worker_earnings` by `worker_lifetime_earnings_paise()` rather than from
  `worker_state.lifetime_earnings_paise`, which nothing maintains. Under the
  line, UPI alone is enough and KYC completes with no PAN at all.
- **Razorpay's PAN endpoint is configuration, not a constant.** Unlike the
  payment APIs it is enabled per merchant under contract and has no published
  path, so it is `RAZORPAY_PAN_VERIFY_URL` and `verifyPan()` throws when it is
  unset. Everything else still works: a worker under ₹5,000 verifies on the
  penny drop alone, and above it the screen says PAN cannot be checked rather
  than storing one nobody read. **A PAN is never recorded unverified** — that is
  the failure mode this design exists to avoid.
- **A mistyped account number is a permanent block**, because a wrong-but-real
  account comes back in a stranger's name. That is spec §6's rule working, not a
  bug, and it is why the form has a second account-number field that never
  leaves the browser and states the consequence next to the button.
- **A duplicate PAN is flagged, not refused.** 0005 chose that and it is right:
  a household sharing a PAN and a fraud ring look identical from here.
  Verification proceeds, both sides of the collision are marked, and the row
  goes to `/admin/kyc` for a person.
- Not built: changing a verified destination. `canSubmit` is false once
  verified, so a worker who switches banks currently needs an admin. Doing it
  properly means re-verifying the new account before retiring the old one, which
  is a flow, not a field.

---

## Disputes

Spec §7's dispute module and spec §11's three outcomes. V1 is layer 3 only —
§16 cuts the four-layer system down to "handle disputes personally at first" —
so `resolve_dispute()` (0034) is a human decision and there is no auto-resolver,
no self-settlement screen and no instant split.

```
release   escrow → worker payable + revenue + tax     the acceptance ledger
refund    escrow → a `pending` refunds row            nothing moves yet
split     both, pro-rated by split_client_bps
```

- **Only the worker's share moves through the ledger.** The client's share is
  still sitting in the platform's gateway account and Razorpay's refund API is
  not wired, so no entry is written for it. That is the position 0031 leaves a
  payout in, for the same reason, and it keeps the escrow account's balance equal
  to what is actually held. `escrow_holds` records the *decision*; the ledger
  records the *movement*; the two disagreeing is the gap where the gateway call
  goes, not drift.
- **A split pro-rates the worker's commission and GST by the same share as the
  money.** A worker paid 60% of the budget is charged commission on 60% of it,
  both floored, so the remainder lands with the worker and `worker_net` can
  never go negative. At 100% every figure collapses to the frozen one, which is
  the property that matters: a full release and an acceptance are the same four
  ledger legs.
- **The ₹15 dispute fee is not charged.** `disputes.fee_paise` stays 0. Charging
  it needs either a ledger movement against a party or a `worker_adjustments`
  row, and nothing on the platform writes an adjustment yet (0031 says the same
  about penalties). A ₹15 nobody collected would be worse than a zero.
- **Whether a client who wins gets their commission and GST back is left
  open.** Spec §8 and §14 do not decide it — §14 commits only to absorbing the
  gateway fee — so the refund is what was in escrow, which is the budget, and
  the question stays where it belongs rather than being answered inside a
  function.
- **The chat is shown raw.** `message_raw.body` is what was typed and
  `view_disputes` is the only thing that reads it; `messages.body` is what the
  parties saw. A case about off-platform contact is unarguable from the first
  and invisible in the second — which is why 0009 split them.
- **Nothing raises a dispute.** Spec §4's step 8 gives the client accept, revise
  or dispute; the third is not built, on either side. The queue is correct and
  empty, and `resolve_dispute()` is lint-clean but has not been exercised at
  runtime — the same position `cancel_payout_batch()` is in, and for the same
  reason: exercising it would leave a permanently misleading row in what is an
  audit trail.

## Money

- **Store and compute every amount in paise (integer).** No floats anywhere near
  money — `₹149` is `14900`. Format to rupees only at the render edge.
- All commission, fee, and payout maths lives in one module —
  [src/lib/money/commission.ts](src/lib/money/commission.ts), with the fixed
  limits in `lib/constants/` and the versioned rates loaded by
  `lib/money/rates.ts`. Never inline a slab percentage in a component. Its
  output is checked against every worked example in SPEC §8 — all six columns
  of all five rows, plus the ₹149 line-by-line table — in
  [commission.test.ts](src/lib/money/commission.test.ts). Those tests hold a
  copy of the seeded slabs on purpose: change a rate in the seed and they fail
  and name the spec row you broke.
- **Never trust an amount sent from the browser.** Recompute server-side from
  the job record before charging or paying anyone.
- Fees, commission, and GST are always separate visible lines, never folded into
  a total. The spec is explicit about this and it's also a legal requirement.
- GST is a configurable line item, not a hardcoded 18%. It is **added on top of
  each commission share**, never folded into it, and it is a liability — it must
  never appear in a revenue figure.
- **The ₹25 floor splits in the slab's own client:worker ratio** — 7:6 at the
  bottom slab, so ₹13.46 from the client and ₹11.54 from the worker. Round one
  side and give the remainder to the other so the two shares sum to exactly the
  floor. See SPEC.md §8 for the worked ₹149 job.

---

## Code rules

- **Server Components by default.** Add `"use client"` only for state, effects,
  or browser APIs — and push it as far down the tree as it will go.
- TypeScript strict. No `any`; use `unknown` and narrow. No non-null `!` on
  anything that comes from the network or the database.
- Mutations go through Server Actions or Route Handlers, and every one of them
  re-checks authorisation server-side. Hiding a button is not access control.
- Validate all external input at the boundary — form payloads, webhook bodies,
  query params.
- Keep `lib/utils/` pure and side-effect free. Anything that talks to a service
  belongs in its own module.
- Errors: fail loudly in server code, degrade gracefully in UI. No empty
  `catch {}` blocks without a comment saying why the throw is safe to swallow.
- No secrets in client code, no secrets in git, no secrets in log lines.
- Rate limit is 60 req/min per user; anything new that's expensive should assume
  that ceiling rather than invent its own.
- Every admin action writes an audit log entry with a reason. Permanent, no
  deletes.

## Design

Bold and visually rich on marketing surfaces — depth and motion are welcome in
hero areas. Inside the product, fast and clean wins: no decorative animation on
the job feed, the dashboard, or anything a worker sees ten times a day.

## i18n

English only for now, but don't paint us into a corner: no sentences assembled
by string concatenation, no copy baked into image assets, no layouts that break
when a label gets 40% longer.

---

## Scope discipline

**One rule from the spec, worth repeating: design the database for the full
spec, build the UI for V1 only.** Schema changes are painful; adding screens
isn't.

V1 explicitly excludes AI ranking, AI category classification, subscriptions,
rehire, instant payout, the notification centre, tier badges, and the four-layer
dispute system. See SPEC.md §16. Those are all "guess about behaviour you
haven't observed" — but the tables they'll need can exist now.

Don't build ahead of the current request. The spec is the roadmap, not the
backlog for this session.
