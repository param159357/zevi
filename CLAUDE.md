# CLAUDE.md

Working notes for Zevi. Read [SPEC.md](SPEC.md) for what the product is and why;
this file covers how the code is built.

**Status: schema applied, no features yet.** The app scaffold, Supabase clients,
folder structure and the full database schema are in place and pushed. No UI, no
server actions, no route handlers. R2, Razorpay, SES and Sentry are all still
unwired.

---

## Commands

```bash
npm run dev      # dev server on :3000 (Turbopack)
npm run build    # production build
npm run start    # serve the production build
npm run lint     # eslint
npx tsc --noEmit # typecheck — CI gate, run before calling anything done

npx supabase db push   # apply new migrations to the linked project
npx supabase gen types typescript --project-id vsqqrbodwrvjuclqhean \
  > src/types/database.types.ts   # regenerate after every schema change
```

Regenerate types **from Git Bash, not PowerShell** — PowerShell's `>` writes
UTF-16LE with CRLF, which fights `.gitattributes` and produces an unreadable
diff. If it happens anyway:
`iconv -f UTF-16 -t UTF-8 file | tr -d '\r' > file.new`.

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
│   ├── (client)/        job posters: post, shortlist, review, dashboard
│   ├── (worker)/        workers: feed, opt-in, deliver, earnings
│   ├── (admin)/         work queue: approvals, disputes, payouts, users
│   ├── api/             route handlers — webhooks (Razorpay), cron, uploads
│   ├── layout.tsx       root layout
│   └── globals.css      Tailwind entry + theme tokens
├── components/
│   ├── ui/              generic primitives: Button, Input, Modal
│   └── <feature>/       feature-scoped components, colocated by domain
├── lib/
│   ├── supabase/        client.ts (browser) · server.ts (server) · middleware.ts
│   ├── constants/       commission slabs, deadline caps, fee amounts, limits
│   ├── utils/           pure helpers only
│   └── env.ts           validated environment access
├── hooks/               shared React hooks
├── types/               database.types.ts (generated) + shared domain types
└── middleware.ts        session refresh on every request

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

### Schema

19 migrations, 81 tables, RLS on every one. What to know before writing a query:

- **`profiles` is PII and no policy exposes it to another user.** What others may
  see lives in `public_profiles` (a trigger-maintained projection),
  `worker_profiles` and `client_profiles`. Private counters live in
  `worker_state` and `user_private_stats` — dispute rate and risk score are
  admin-only *by table*, not by remembering to trim a SELECT list.
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
- **Append-only, enforced by trigger**: `admin_audit_log`, `job_events`,
  `ledger_*`, `job_financials`. UPDATE and DELETE raise.
- **Tunables live in `platform_settings`**, read via `setting_int()` /
  `setting_bigint()` / `setting_bool()`. Slabs, tax and fees do not — see above.
- Policy helpers: `is_admin()`, `admin_can(perm)`, `is_active_worker()`,
  `is_job_participant()`, `is_job_client()`, `worker_works_in_category()`,
  `is_conversation_participant()`, `is_dispute_party()`. Call them as
  `(select public.is_admin())` inside a policy so Postgres evaluates once per
  statement rather than once per row.

Money-moving writes — acceptance, escrow release, payouts, dispute decisions —
have INSERT/UPDATE revoked from `authenticated` at the table level. They run
server-side with the service-role client, in the same transaction as their
ledger entries. That is not a workaround for a missing policy; it is the policy.

---

## Money

- **Store and compute every amount in paise (integer).** No floats anywhere near
  money — `₹149` is `14900`. Format to rupees only at the render edge.
- All commission, fee, and payout maths lives in one module under
  `lib/constants/` + a dedicated calculator. Never inline a slab percentage in a
  component.
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
