# CLAUDE.md

Working notes for Zevi. Read [SPEC.md](SPEC.md) for what the product is and why;
this file covers how the code is built.

**Status: a job now runs end to end, from posting to completion.**
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

Nothing beyond that: no chat, no ratings, no disputes, no KYC — and **money still
cannot leave the platform account**. Escrow releases into a worker's payable
balance, but payouts and refunds do not exist, so that balance is where it stops.
SES, Sentry and SMS are unwired, and uploads sit in Supabase Storage until R2
replaces it.

---

## Commands

```bash
npm run dev      # dev server on :3000 (Turbopack)
npm run build    # production build
npm run start    # serve the production build
npm run lint     # eslint
npm test         # vitest — the commission calculator and the payment signatures
npx tsc --noEmit # typecheck — CI gate, run before calling anything done

npx supabase db push   # apply new migrations to the linked project
npx supabase gen types typescript --project-id vsqqrbodwrvjuclqhean > src/types/database.types.ts

# The auto-accept sweep. Vercel Cron calls this hourly in production; nothing
# calls it locally, so a delivery past its window sits there until you do.
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/auto-accept
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
│   ├── (worker)/        workers: feed, opt-in, deliver, earnings
│   ├── (admin)/         work queue: approvals, disputes, payouts, users
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
│   ├── admin/           console guard + approval queue: session · actions · queries
│   ├── money/           commission.ts (the calculator) · rates.ts (lookup)
│   ├── payments/        Razorpay: actions · settle · razorpay · signature · quote
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

30 migrations, 81 tables, RLS on every one. What to know before writing a query:

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
- Not built yet: KYC (spec puts it before the first payout, not at signup), the
  60-second cap on video samples, and watermarked sample previews. The
  watermarker itself now exists — `lib/deliveries/preview.ts`, built for
  deliveries — so pointing samples at it is a small job whenever the shortlist's
  unwatermarked signed URLs start to matter. The other two land with R2.

### The console

`/admin` is a work queue (spec §7). Worker approvals is the only module that
exists; `/admin` redirects there rather than pretending to be a shell for five
queues that do not exist.

Access is checked three times, deliberately not the same check three times:
`requireAdmin(perm)` decides what renders (and 404s everyone else rather than
admitting the route exists), the `admin_can(...)` policies decide what the
queries return, and `review_worker_application()` looks the permission up again
from the reviewer's id — under the service-role key `auth.uid()` is null, so
`admin_can()` would answer false for a super admin.

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
  wired. Transfers go to *linked accounts*, which need worker KYC, which spec §6
  puts before the first payout rather than at signup. So the money is captured
  into the platform account and held there, with `escrow_holds` and the ledger
  as the record of whose it is — the same position an `on_hold` Route transfer
  leaves it in, minus the linked account. `transferForJob()` in
  `lib/payments/razorpay.ts` is the seam, and it throws.
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
  jobs (spec §6's chargeback window). Nothing moves it further: payouts are the
  next thing, and `EarningSummary` says so rather than promising a Friday.

---

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
