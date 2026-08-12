# ZEVI — Master Specification

*Micro-gig marketplace for small digital work*

---

## 1. THE IDEA

A marketplace for small digital jobs that big platforms ignore.

Fiverr and Upwork are built for ₹5,000+ projects. A ₹300 PPT, a ₹400 poster, a ₹500 reel edit has no home — too small to be worth a freelancer's profile-building effort, too awkward for a client to search for.

**Zevi is where that work lives.**

Two insights drive it:

1. **The size gap is real.** Small jobs get lost on big platforms because fees and friction eat them alive.
2. **The barrier is the approach, not the skill.** Plenty of people can design a poster or edit a video but won't cold-message strangers for work. Zevi removes the approach entirely — work comes inbound, price is set, no pitching, no negotiation.

**Scope:** Any small digital gig deliverable online. No geography — buyer and worker never meet.

**Both sides open to anyone:** students, freelancers, homemakers, retired people on the supply side. Shops, students, businesses, event organisers on the demand side.

**Parked for later:** in-person photography (tourists, events). Out of scope for now.

---

## 2. PLATFORM DECISIONS

| Decision | Choice |
|---|---|
| Name | **Zevi** |
| Platform | Website only, no app |
| Language | English, with i18n scaffolding for later |
| Parts | Client · Worker · Admin |
| Design | Bold, visually rich — depth and motion in hero areas, fast and clean inside the product |

**Trademark note:** an existing Indian company uses zevi.ai (AI search for e-commerce). Different category, but run a trademark search on the IP India site before printing anything.

---

## 3. TECH STACK

| Layer | Tool | Why |
|---|---|---|
| Frontend + backend | **Next.js (TypeScript)** | One language, easiest to hire for |
| Database + auth | **Supabase** | Database, login, security in one |
| File storage | **Cloudflare R2** | Zero egress fees — the critical saving |
| Hosting | **Vercel** | Free to start |
| Email | **Amazon SES** | Cheapest reliable option |
| Payments | **Razorpay Route** | India standard, handles escrow and splits |
| CDN / protection | **Cloudflare** | Free, absorbs spikes, blocks bots |
| Styling | **Tailwind CSS** | |

### Running costs

| Stage | Jobs/month | Monthly cost |
|---|---|---|
| Launch | 0–200 | ₹2,350 |
| Growing | 1,000 | ₹2,500 |
| Working | 5,000 | ₹6,000 |
| Scaling | 20,000 | ₹18,000 |

**Break-even: ~55–60 completed jobs/month (about 2 a day).**

### Build-in from day one (not upgrades — correctness)

- Indexes on every filtered/sorted column
- Cached job feed (30–60 seconds)
- Pooled database connections
- Database-level locking on job assignment (prevents double-assignment)
- Rate limiting: 60 requests/minute per user
- Background jobs for payouts, emails, file processing
- Sentry for error monitoring

### Upgrade triggers

| Signal | Action | Cost |
|---|---|---|
| ~10,000 visitors/month, pages sluggish | Upgrade Supabase compute | +₹4,000/mo |
| ~50,000 visitors/month, feed slow | Add read replica | +₹8,000/mo |
| ~200,000 visitors/month | Separate background job queue | Engineering project |
| Heavy video volume | Automatic video compression | — |

**Watch:** page load >1s, errors in logs, database CPU >70%.

---

## 4. THE CORE FLOW

1. Client posts a job — **free, no payment yet**
2. Job appears in the feed for workers in that category
3. Interested workers opt in (one tap + 3 short fields)
4. Client sees a shortlist of up to 5
5. Client picks one — **payment happens here**, into escrow
6. Work happens, chat available with contact masking
7. Worker delivers (watermarked preview for visual work)
8. Client accepts, requests the 1 free revision, or disputes
9. Auto-accept fires if the client goes silent
10. Worker paid in the next cycle, minus commission
11. Both sides rate each other, blind

**Payment at selection, not posting** — this is deliberate. It eliminates gateway fees on jobs nobody takes and removes friction from posting.

---

## 5. CLIENT SIDE

### Signup
Email + mobile, both compulsory and verified.

### Posting a job
- Category tiles, or **"Other"**
- Title, description, attachments
- **Minimum budget ₹149**
- Client sets deadline, capped by value: under ₹2,000 → 7 days max · ₹2,000–4,999 → 15 days · ₹5,000+ → 30 days
- Fee shown as a separate line, never hidden
- Drafts saved automatically
- Editable freely until a worker is assigned; after that description and budget lock, deadline can only be extended

### "Other" category
AI classifies on submit (never while typing — most forms are abandoned). Silent classification, category visible on the job page, editable until assignment. Low-confidence cases go to an admin queue and become the roadmap for new categories.

**Cost:** ~₹0.03 per job on Haiku. Prompt caching makes it cheaper still.

### Shortlist
Up to 5 workers, **only from those who opted in**:
- 1 highest-rated
- 3 middle (AI-ranked on relevance, weighted 40% note / 60% delivery history)
- 1 newest

If fewer opt in, show whoever's there. If nobody qualifies as Top tier, that slot becomes a fourth middle slot. Never show an empty slate.

### Reviewing delivery
- Accept → escrow releases
- Request revision → **1 free**; a second only by worker agreement, otherwise dispute
- Dispute → goes to the resolution flow
- **Auto-accept:** 36 hours under ₹1,000 · 3 days at ₹1,000+. Reminders at 12h/30h and 24h/60h.

### Cancellation

| When | Refund |
|---|---|
| No worker assigned yet | Full, instant, no fee |
| ≤30% of deadline elapsed | Full, minus ₹15 |
| 31–50% elapsed | 80% client / 20% worker, minus ₹15 |
| >50% elapsed | Admin assesses; client refund capped at 70% |
| **After delivery** | **No percentage refund — accept, revise, or dispute only** |

### Ratings
Mandatory for clients, optional for workers, blind both ways, 1–5 stars plus 3 quick tags.

### Public client profile
Rating, jobs completed, member since, cancellation rate. **Dispute rate stays admin-only.**

### Other
- Dashboard: active jobs, awaiting review, past jobs, payments, receipts
- Rehire: client can address a job directly to a past worker; declined jobs fall through to the normal shortlist
- Reporting: abuse, plagiarism, off-platform contact, impersonation
- Support: Help link on every job page, ticket tied to job ID, 48h response

---

## 6. WORKER SIDE

### Signup
Email + mobile verified. Full name matching ID. **Maximum 3 categories.**

### Samples
- 3 minimum, 6 maximum per category
- One-line caption each: what it was, what they did
- Category-specific formats (PPT → actual file or PDF; video → 60s max; design → source quality)
- Watermarked on display
- Explicit "did you make this alone?" checkbox

### Admin approval
24-hour SLA. Three outcomes: approve · reject with reason · approve-with-flag (watched on first delivery). Reverse image search on design samples. Rejected workers may resubmit once after 7 days.

### KYC — before first payout, not at signup

| Field | Purpose |
|---|---|
| Full name | Must match bank account |
| PAN | TDS, mandatory above ₹5,000 lifetime |
| Bank + IFSC, or UPI ID | Payout destination |
| Date of birth | 18+ confirmation |

**Verification via Razorpay:** penny-drop returns the real account holder name; PAN API returns the registered name. Both compared automatically.

**Rules:** name mismatch = blocked, no override · one PAN per account, duplicates flagged · under ₹5,000 lifetime, UPI alone is enough · 3 failed attempts → admin review.

**Cost:** ₹3–5 per worker, one time.

### Job feed
Filtered to their categories, newest first. Each card shows title, budget, deadline, client rating, jobs completed, **and how many have already opted in**.

### Opting in
One tap, then three short fields (300 characters total):
- What software will you use?
- What's your turnaround?
- **One thing you noticed in this brief**

That third field is the anti-AI-slop defence — it can't be answered generically.

**20-second dwell timer** before the button activates. **Maximum 5 active opt-ins.**

### Delivery
- Visual work (design, PPT, photo, video): watermarked preview visible, clean file unlocks on acceptance
- Code, documents, spreadsheets: viewable but not downloadable until acceptance
- All files through the platform — never chat or external links

### Earnings
Pending → Confirmed → Paid. Next payout date shown prominently. Per-job breakdown with commission and tax as separate lines.

### Payouts
**Twice weekly.** Cycle closes Wednesday midnight → paid Friday. Closes Sunday midnight → paid Tuesday.

**Eligibility:** client acceptance (or auto-accept) **plus 48 hours** before the cycle cutoff. Anything short rolls forward.

**New client exception:** worker payout held **14 days** for a new client's first 3 jobs (chargeback protection).

### Penalties

| Offence | Consequence |
|---|---|
| Abandon a job | Rating hit · ₹15 debit blocking new jobs · 12% off pending earnings · up to ₹50 off next completed job |
| Abandon before any completed job | Immediate 7-day suspension |
| Second abandonment ever | Permanent removal |
| Rating below 3.0 across 10+ jobs | Removed from shortlists, samples must be resubmitted |
| Off-platform contact | Warning → rating penalty → suspension |
| Plagiarised samples or delivery | Immediate permanent ban, earnings frozen |

**Grace window:** first 3 jobs — sub-3 ratings don't affect the public record, but **admin sees real scores from job one**. Two sub-3 ratings in the first three triggers review before a fourth job.

### Tiers

| Tier | Requirement | Shortlist eligibility |
|---|---|---|
| New | 0–4 jobs | Newest slot |
| Established | 5+ jobs | Middle slots |
| Top | 10+ jobs, ≥4.5 rating, zero abandonments in last 20 | Top slot |

**Newest slot rotation:** a worker occupies it for a maximum number of shortlists or days, then rotates out even if unpicked — otherwise one person camps it and the slot fails its purpose.

### Rating maths
- Weighted average starting near the platform mean, converging over ~10 jobs — not a raw average
- Recency-weighted (last 3 months count more)
- Cancellations and abandonments feed the score
- **Category-specific** — 4.9 at PPTs and 3.2 at video shouldn't blend
- Job count always shown: "4.8 ★ (52 jobs)"

---

## 7. ADMIN SIDE

**Home is a work queue, not a stats dashboard** — ordered by what's rotting: disputes past SLA, approvals nearing 24 hours, unassigned jobs about to expire, failed payouts, flagged reports.

| Module | Contents |
|---|---|
| Disputes | One screen per case: brief, files, chat, both statements, both histories. Three actions: release · refund · split. **Required internal note on every decision.** |
| Worker approvals | Samples, captions, reverse-image-search link. Approve / reject / flag. |
| Users | Full history, ratings, disputes, cancellations, earnings, KYC. Warn · suspend · ban. Every action logged with reason. |
| Payouts | Escrow balance, batch review before each run, failed-payout queue with retry |
| Categories | Add, rename, retire. Volume and average price per category. "Other" queue and AI results. |
| Reports | Abuse, plagiarism, off-platform contact, impersonation |

### Analytics — six numbers only
1. Jobs posted vs completed
2. Time from post to assignment
3. Dispute rate
4. Worker retention (% doing a second job)
5. Client retention (% posting a second job)
6. GMV and commission

**Repeat rate on both sides is the number that tells you whether Zevi works.**

### Access
Single super-admin at launch, but **build roles now** — support staff who see disputes but can't touch payouts. **Permanent audit log** on every admin action.

---

## 8. COMMISSION & REVENUE

### Slabs

| Job value | Total | Client | Worker |
|---|---|---|---|
| ₹149–499 | 13% (min ₹25) | 7% | 6% |
| ₹500–1,999 | 11% | 6% | 5% |
| ₹2,000–4,999 | 9% | 5% | 4% |
| ₹5,000+ | 8%, capped ₹1,500 | 4.5% | 3.5% |

**Client always pays the higher share** — workers are the scarce side.

**Descending by design:** 11% on a ₹10,000 job is exactly the number that makes two people swap phone numbers. Dropping to 8% removes the incentive where leakage hurts most.

**₹25 floor applies after all discounts.**

### Worked examples

| Job | Client pays | Worker gets | Zevi gross | Zevi net |
|---|---|---|---|---|
| ₹149 | ₹159 | ₹140 | ₹25 | ~₹21 |
| ₹400 | ₹428 | ₹376 | ₹52 | ~₹41 |
| ₹500 | ₹530 | ₹475 | ₹55 | ~₹42 |
| ₹2,000 | ₹2,100 | ₹1,920 | ₹180 | ~₹129 |
| ₹10,000 | ₹10,450 | ₹9,650 | ₹800 | ~₹552 |

### Other fees
- **Cancellation: ₹15 flat** (actual gateway cost above ₹2,000). Never charged when no worker opted in — that's Zevi's failure, not the client's.
- **Dispute: ₹15**, charged to whoever loses. Split decisions split the fee.
- **Instant payout: ₹15** (later)

### Subscriptions — after launch, not day one

| Plan | Price | Benefit |
|---|---|---|
| Zevi Pro (worker) | ₹149/mo | Unlimited opt-ins, −1% commission, 8 free instant payouts |
| Zevi Pro+ (worker) | ₹399/mo | −2% commission, guaranteed shortlist entry, featured placement |
| Zevi Business (client) | ₹499/mo | −2% commission, unlimited rehire, brief templates, priority disputes, GST invoicing |

**Three rules:** free users keep full core access · the newest-worker slot is never sellable · discounts cap at 2% total.

**Why subscriptions matter:** commission scales with jobs, and so does support cost — they cancel out. Subscription revenue arrives whether or not anyone posts. It's the only line that safely funds salaries.

### Loyalty
Top-tier workers (4.5+, 25+ jobs, zero abandonments): **1% off at every slab**, stacking to the 2% cap.

### GST
18% on commission from both sides, shown as a separate line. **Built as a configurable line item** — rates confirmed with a CA before launch.

---

## 9. UNIT ECONOMICS

**Funnel:** 100 visitors → 70 posted → 60 hired → 50 completed. Average job ₹400.

| | Amount |
|---|---|
| Commission (50 × ₹52) | ₹2,600 |
| Cancellation fees (10 × ₹15) | ₹150 |
| Razorpay (60 assigned jobs only) | −₹606 |
| Payouts | −₹50 |
| **Net per 100 visitors** | **≈ ₹2,050** |

| Visitors/month | Completed | Net after infra |
|---|---|---|
| 1,000 | 500 | ₹15,900 |
| 3,000 | 1,500 | ₹57,800 |
| 10,000 | 5,000 | ₹204,400 |

### Outcome table

| Outcome | Zevi profit |
|---|---|
| Job completes | ₹41 |
| Auto-completes | ₹41 |
| Dispute, worker wins | ₹56 |
| Dispute split | ₹31 |
| Late cancellation | ₹20 |
| Early cancellation | ₹5 |
| No worker found | ₹0 |
| Worker abandons | −₹10 |
| Dispute, client wins | −₹10 |
| **Chargeback** | **−₹2,400** |

**You make money when jobs finish. You break even when they cancel. You only lose real money on fraud.**

### The debt threshold

Ordinary failures can't bankrupt you — at 500 completed jobs you'd need 1,420 abandonments to go negative. **Volume is the risk, not failure rate.** Below ~55 completed jobs a month you're in debt regardless.

**Chargebacks are the exception.** At 200 jobs/month, **one chargeback wipes out the month.** One fraudulent ₹10,000 job costs you 290 honest ₹400 jobs.

---

## 10. RISK & FRAUD

### Chargebacks — the only thing that could end the business

- Worker payout held **14 days** on a new client's first 3 jobs
- **Manual admin review on any first job above ₹2,000**
- **Cap job value at ₹5,000 for the first 3 months**
- Auto-flag when client and worker share device, IP, or payout destination
- **Reserve 2% of monthly GMV** — never counted as profit
- Worker earnings freeze on any chargeback pending investigation

### Collusion
Same person or friends cycling fake jobs to inflate ratings or launder money. Detection signals: shared device fingerprint, shared IP, shared bank/UPI, unnaturally fast completions, always 5 stars, no chat activity, pairs who only transact with each other.

**Build a simple internal risk score from day one** — device, IP, payout destination, completion speed, chat volume. Visible in the user record. No machine learning needed.

### Disintermediation
Contact details **masked** in chat (numbers, emails, links render as `[contact hidden]`, message still sends). Catch spelled-out digits and common evasions. Native file sharing only. One-line explanation framed as payment protection. Warning → rating penalty → suspension.

**What actually retains people:** escrow, dispute cover, and ratings that only accumulate on-platform. A worker's rating is their livelihood — going direct builds it nowhere.

Accept that determined pairs leak. You're stopping the easy 80%.

### Sample theft
Reverse image search at approval, client reports after. Permanent ban, earnings frozen.

---

## 11. DISPUTES — FOUR LAYERS

**Layer 1 — Auto-resolve, no human.** ~50–60% of cases:
- Nothing delivered by deadline → full refund, worker penalised
- Client silent past auto-accept → auto-completes, worker paid
- No files uploaded at all → automatic refund
- Cancellation inside the time tiers → rules apply automatically
- Worker abandoned → automatic full refund

**Layer 2 — 24-hour self-settlement.** Structured screen: client states the problem and picks an outcome, worker accepts, counters, or rejects. ~30% of the remainder settles here.

**Layer 3 — AI summarises, human decides.** AI reads brief, chat, delivery, both statements → one-screen summary with recommendation. **Time per dispute: 20 minutes → 3 minutes.** Cost ~₹2. AI never auto-resolves real disputes.

**Layer 4 — Under ₹300:** instant 50/50 split, one tap each.

**Net effect:** 100 disputes → ~1 hour of admin time instead of 33.

### Rules
- Both sides can raise a dispute
- Client window: delivery until 48h after acceptance. Worker window: assignment until payout
- Required 500-character statement from each; other side has 24h to respond
- **48h to first response, 5 days to decision** — stated on screen
- One appeal, 48h window, only with new evidence
- Money freezes the moment a dispute opens
- Three outcomes only: release · refund · split
- **Track dispute rate per user** — the most useful signal you'll have in year one

### Prevention beats resolution
**Structured briefs per category** — required fields like slide count, video length, dimensions, file format. Most disputes come from vague descriptions where both sides genuinely believed something different.

---

## 12. FILES & STORAGE

| Job outcome | Deletion |
|---|---|
| Delivered, accepted, no dispute | 7 days after acceptance |
| Disputed | 30 days after dispute closes |
| Cancelled or abandoned | 7 days |
| Never assigned | Immediately on expiry |

**Retained permanently:** file hashes, names, sizes, timestamps, watermarked preview. A few KB per job — your evidence if a chargeback lands months later.

**Upload caps:** video 500MB · design 100MB · documents 25MB.

**Warnings:** client at acceptance and worker at delivery — *download your copy, files are removed after 7 days.*

*Note: with R2's zero egress, storage is nearly free. Retention could safely extend to 30 days for ~₹300/month — better for disputes.*

---

## 13. PROHIBITED WORK

- **Academic submissions** — assignments, projects, theses, exams, or anything submitted as the student's own work. *Formatting, review, tutoring, and design of work they've already done is allowed.* This is the most common request you'll receive and the line must be explicit.
- Anything requiring someone else's login credentials
- Adult or sexual content
- Impersonation — writing as someone else, fake reviews, fake profiles
- Anything illegal, or promoting harm, hatred, or violence
- Copyright infringement — logo copies, pirated assets, ripped stock
- Deceptive material — fake documents, forged certificates, misleading ads

**Enforcement:** violating jobs cancelled with full client refund. Repeat posters banned. Workers who accept them share the penalty.

---

## 14. REFUNDS & FAILED PAYOUTS

**Refunds** go back to the original payment method, 5–7 working days. **Zevi absorbs the ~2% gateway fee** on refunds — charging a client for a worker's abandonment loses them permanently. Every refund generates its own document with reason logged.

**Failed payouts** (wrong account, name mismatch): money returns to escrow, worker sees a clear banner, auto-retry next cycle once details change. 3 consecutive failures → account flagged. Unclaimed 12 months → notify, then follow CA guidance.

---

## 15. NOTIFICATIONS

**Email for essential events only:**

*Client:* verify email · payment received · shortlist ready · worker assigned · work delivered · auto-accept reminder · job completed · refund issued · dispute update

*Worker:* verify email · application approved/rejected · you've been selected · revision requested · payout sent · penalty notice

Plain, short, one action each, job ID in every subject line. **Set up SPF and DKIM from day one** or half of these land in spam — which on a website-only platform means users never hear from you.

**Everything else:** in-site notification centre.

*Known weakness: an in-site bell only reaches someone already on the site. If workers report missing jobs, browser push for "new job in your category" is the fix.*

---

## 16. WHAT SHIPS IN V1

### In

**Client:** signup (email + mobile verified) · post a job · payment at selection · shortlist and samples · pick a worker · chat with masking · receive delivery · accept or 1 revision · auto-accept · cancellation tiers · mandatory blind rating · dashboard

**Worker:** signup + samples · admin approval · category-filtered feed · opt in (3 fields, max 5 active) · deliver · revision · earnings dashboard · twice-weekly payout · KYC before first payout · optional blind rating

**Admin:** approval queue · dispute queue · user management · payout batch review · job and transaction list

**System:** escrow via Razorpay Route · commission slabs + ₹25 floor · ₹15 cancellation fee · R2 storage with deletion rules · essential emails · watermarked previews

### Out

- AI ranking of middle 3 → show all opted-in workers sorted by rating
- AI category classification → "Other" goes to a manual admin queue
- Subscriptions · two-stage jobs · instant payout · promoted placement · rehire · notification centre
- The 4-layer dispute system → handle disputes personally at first
- Loyalty discounts · tier badges · i18n translations (keep scaffolding)

**Why:** every cut item is a guess about behaviour you haven't observed. The shortlist algorithm assumes worker abundance. AI ranking assumes enough opt-ins to rank. Subscriptions assume proven value. Build them now and you'll rebuild them in month three.

**One rule while building: design the database for the full spec, build the UI for V1 only.** Schema changes are painful; adding screens isn't.

---

## 17. LAUNCH PLAN

**The problem:** a client who posts and gets no workers leaves forever. A worker who checks an empty feed leaves forever. One shot at each person.

### Sequence

**Weeks 1–2** — Recruit 20–30 workers before a single client sees the site. Approve samples. Seed 10 real jobs you actually need and pay for.

**Weeks 3–4** — Open to 20 clients. Match manually. Watch every delivery.

**Month 2** — Fix what broke. Then grow one category at a time.

### Rules

**Two categories only at launch.** Likely PPT design and video editing. Twenty workers across two categories looks healthy; across eight it looks abandoned.

**Where workers come from:** college design and film clubs, campus WhatsApp groups, Instagram accounts of student editors, small Behance and Dribbble profiles — and highest-converting of all, people already doing this informally for friends without charging properly.

**Individual messages, not broadcasts.** Twenty personal messages beat two thousand impressions.

**What you offer them:** zero commission for the first month, guaranteed early shortlist placement, and honesty that it's new and quiet. **Never promise volume you can't deliver.**

**Be the algorithm for the first month.** Job posts → you personally message three suitable workers to opt in. The client experiences a fast platform. You learn what the algorithm needs to do.

**Never fake jobs.** Seed with real ones you pay for. Fake jobs poison trust the moment someone notices.

**Guard rail: if a job sits unassigned for six hours in the first month, fill it personally — including doing it yourself.** Zero unfilled jobs is worth more than any feature.

### The only number that matters

**Second jobs.** A client who posts twice, a worker who delivers twice. If ten of your first thirty clients come back, Zevi works. If two do, something is broken and more marketing just spends money faster.

---

## 18. BEFORE LAUNCH — NOT PRODUCT WORK

- **Entity registration** — Razorpay won't onboard an unregistered business
- **CA conversation** — nodal/escrow account structure (you cannot hold client funds in an ordinary current account), GST on commission, TCS under section 52, TDS under 194-O
- **Razorpay Route setup**
- **Legal pages** — Terms of Service, Privacy Policy, Refund & Cancellation Policy, Prohibited Work. Razorpay asks for these. Have a lawyer review — Indian marketplace terms touch the Consumer Protection (E-Commerce) Rules, IT Act intermediary rules, and DPDP Act.

**Get the escrow structure right before taking the first rupee. It's the most expensive thing to fix retroactively.**

---

*Spec complete. Everything above is decided unless marked otherwise.*
