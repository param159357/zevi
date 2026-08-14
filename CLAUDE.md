# CLAUDE.md

Working notes for Zevi. Read [SPEC.md](SPEC.md) for what the product is and why;
this file covers how the code is built.

**Status: schema applied, auth built, clients can post jobs, workers can apply.**
The app scaffold, Supabase clients, folder structure and the full database schema
are in place and pushed. Signup and login work end to end for both sides — email
verified through Supabase, mobile through our own OTP. A client can post a job:
category tiles, brief, attachments, budget and deadline, autosaved as a draft and
published through `publish_job()`. A worker can add 3–6 samples per category with
captions and submit them, and an admin can approve, flag or reject from the
console queue. Nothing beyond that: no feed, no opt-ins, no shortlist, no
payment, no delivery, no KYC. Razorpay, SES, Sentry and SMS are still unwired,
and uploads sit in Supabase Storage until R2 replaces it.

---

## Commands

```bash
npm run dev      # dev server on :3000 (Turbopack)
npm run build    # production build
npm run start    # serve the production build
npm run lint     # eslint
npx tsc --noEmit # typecheck — CI gate, run before calling anything done

npx supabase db push   # apply new migrations to the linked project
npx supabase gen types typescript --project-id vsqqrbodwrvjuclqhean > src/types/database.types.ts
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
| Payments | Razorpay Route | not wired up |
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
│   ├── admin/           console guard + approval queue: session · actions · queries
│   ├── money/           commission.ts (the calculator) · rates.ts (lookup)
│   ├── uploads/         client.ts — browser-side hashing and object naming
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

27 migrations, 81 tables, RLS on every one. What to know before writing a query:

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
  60-second cap on video samples, and watermarked previews — samples are private
  and only their owner and a reviewer can see them, so nothing is displayed
  unwatermarked. All three land with the R2 pipeline.

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

## Money

- **Store and compute every amount in paise (integer).** No floats anywhere near
  money — `₹149` is `14900`. Format to rupees only at the render edge.
- All commission, fee, and payout maths lives in one module —
  [src/lib/money/commission.ts](src/lib/money/commission.ts), with the fixed
  limits in `lib/constants/` and the versioned rates loaded by
  `lib/money/rates.ts`. Never inline a slab percentage in a component. Its
  output is checked against every worked example in SPEC §8.
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
