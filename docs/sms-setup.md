# SMS: MSG91, DLT and the verification code

Spec §5 and §6 both make mobile verification compulsory, and `resolveStep()`
will not move a user past `verify_mobile` until `profiles.mobile_verified_at` is
set. `verify_phone_otp()` is the only writer of that column and it needs a code
the user actually received — so **until this runbook is done, nobody can finish
signing up on a production deployment.**

This is a runbook. The code it refers to is in [`src/lib/sms/`](../src/lib/sms),
and the design notes live in [CLAUDE.md](../CLAUDE.md#sms).

The application half is small: one POST to one endpoint. The half that takes
time is DLT, and it is not optional — it is telecom regulation, enforced by the
operators, and no amount of application code substitutes for it.

---

## What you need before you start

- **A registered business** with a PAN, a GST number and a letterhead. DLT
  registration is done as a legal entity, not as a person.
- **An MSG91 account** — [msg91.com](https://msg91.com). Signup is free; sending
  needs credit.
- **Three to seven working days.** Entity approval is 1–2, a header 1–2, and a
  template 1–2 more, each with a rejection loop if you get the wording wrong.
  Start this before you need it.

---

## 1. Why DLT exists, and what it means for this code

TRAI's Telecom Commercial Communications Customer Preference Regulations put
every commercial SMS in India on a blockchain-backed registry ("DLT"). Three
things are registered separately, and an operator checks all three at delivery
time:

| Registered | What it is | Example |
|---|---|---|
| **Entity** | Your business, with a Principal Entity ID | Zevi Pvt Ltd |
| **Header** | The six-character sender id a message arrives from | `ZEVIIN` |
| **Template** | The exact wording, with variable slots | see §4 |

A message whose text does not match an approved template is **dropped by the
operator**, not by MSG91 — so it can be accepted by the API, billed, and never
arrive.

That is why there is no message body anywhere in `src/lib/sms/`. What the
application sends is a template id, a sender id and a set of variables; the words
live on the DLT portal. Keeping a second copy in TypeScript would be a copy that
drifts and that nothing sends.

---

## 2. Register the entity and the header

DLT registration happens on **one** operator's portal and propagates to the
others. Jio's ([trueconnect.jio.com](https://trueconnect.jio.com)) is the one
most people use; Airtel and VI have equivalents and either is fine.

1. Register as a **Principal Entity**. You will need the PAN, the GST
   certificate, a letter of authorisation on letterhead, and an OTP-verifiable
   number and email. You get a **Principal Entity ID** — a long numeric string.
2. Register a **Header** of type **Transactional**. Six alphanumeric characters,
   related to the brand: `ZEVIIN` for zevi.in. It is what the message arrives
   from, and it is what people will read as the identity of a code asking them
   to trust it.

   OTP traffic is **transactional**, never promotional. Promotional headers are
   blocked on DND numbers, which is most numbers, and a verification code that
   fails for anyone on the DND registry is a signup that fails for most of India.

3. In MSG91, go to **Sender IDs** and add the approved header so the account can
   send under it.

---

## 3. Connect the entity to MSG91

MSG91 → **Settings → DLT** (or "Entity ID" on the SMS settings page). Enter the
Principal Entity ID from §2. MSG91 passes it to the operators with every send;
without it, every message is rejected with *"Invalid sender ID or DLT Entity Id
Missing"*.

---

## 4. Register the template, and use these exact variable names

Register a **Transactional** content template on the DLT portal. The text has to
be approved character for character, with variable slots written as `{#var#}`:

```
{#var#} is your Zevi verification code. It is valid for {#var#} minutes. Do not share it with anyone.
```

Then create the matching template in MSG91 (**Templates → Add Template**), where
the same slots are *named*. The names are not decoration — MSG91 matches on them,
and the application sends exactly these two:

```
##OTP## is your Zevi verification code. It is valid for ##VALIDITY## minutes. Do not share it with anyone.
```

| Variable | What the application sends |
|---|---|
| `OTP` | The six-digit code, from `randomInt` in `sendMobileOtp` |
| `VALIDITY` | Minutes, derived from `OTP_TTL_SECONDS` — `10` today |

**`VALIDITY` is a variable rather than a number in the text on purpose.** The
minutes the message promises and the minutes `request_phone_verification()`
actually allows would otherwise be two constants in two systems, one of which
takes two days to change. If you register the text with a literal "10 minutes"
and only an `##OTP##` slot, everything still works — MSG91 ignores a variable
the text has no room for — you have just stopped tracking the constant, and
changing `OTP_TTL_SECONDS` will make the message lie.

**Do not add anything that looks like a link.** `short_url` is sent as `"0"`, so
MSG91 does no link rewriting; a shortened URL in a message asking for a secret is
the exact shape of the phishing this message is teaching people to trust.

MSG91 shows the **Template ID** next to the approved template — a long hex
string. That is `MSG91_OTP_TEMPLATE_ID`.

---

## 5. Configure the application

MSG91 → **Settings → API Keys** for the auth key, then set three variables:

```bash
MSG91_AUTH_KEY=...              # one key, full account access — treat it like the Razorpay secret
MSG91_SENDER_ID=ZEVIIN          # the approved header from §2
MSG91_OTP_TEMPLATE_ID=...       # the Template ID from §4
```

All three or none: `isSmsConfigured()` in [`src/lib/env.ts`](../src/lib/env.ts)
requires the set, because DLT refuses a message missing any one of them and two
out of three is indistinguishable from zero.

**Leave them unset locally.** Development prints the code to the server console —
the one place a live OTP is ever printed — so a signup can be walked end to end
without a DLT registration:

```
──── [sms] not sent (MSG91 is not configured) ────
to:        +91 98765 43210
OTP:       417293
VALIDITY:  10
──────────────────────────────────────────────────
```

In production, an unset variable throws `SmsNotConfiguredError` and the signup
fails loudly on the first attempt. That is deliberate: a signup that silently
strands every user on the mobile step is worse than one that says so.

---

## 6. Buy credit

MSG91 bills per SMS — transactional SMS in India is roughly ₹0.15–0.25 apiece at
low volume. An account with no balance returns *"Insufficient balance"* as an
HTTP **200**, which is exactly the case
[`msg91.test.ts`](../src/lib/sms/msg91.test.ts) pins: it is a refusal, and the
code reads it as one.

---

## 7. Prove it works

With the variables set, sign up with a real number and watch the server log:

```
[sms] verification code sent to +91 98765 43210 (msg91 3554736c4f8d2865fc8b4567)
```

That hex string is MSG91's request id. Paste it into MSG91 → **Reports → SMS**
to see what the operator did with the message — accepted, delivered, or failed
with a reason. It is the only handle tying a support question about a missing
code to a specific attempt, which is why the line exists. Note what is *not* in
it: the code itself, because this line runs in production.

If nothing arrives, in the order worth checking:

| Symptom | Almost always |
|---|---|
| API says `success`, nothing arrives | Template text does not match DLT exactly. Check whitespace and punctuation |
| *"Invalid sender ID or DLT Entity Id Missing"* | §3 was skipped, or the header is not on the MSG91 account |
| *"Template not approved"* / *"Flow Not Yet Approved"* | Still in the DLT queue |
| Placeholder text in the delivered message | Variable names differ between MSG91 and what the app sends — they are case-sensitive |
| Nothing for one number, fine for others | DND, and the header is registered promotional rather than transactional |

---

## 8. What is deliberately not used

**MSG91's OTP API.** MSG91 sells a product that generates the code, stores it,
and exposes `/otp/verify` to check it. This platform uses none of it, because the
code is already ours: `request_phone_verification()` mints it, stores it
bcrypt-hashed, and owns the resend cooldown, the hourly cap and the attempt cap;
`verify_phone_otp()` is the only writer of `profiles.mobile_verified_at`. Handing
the same job to MSG91 would put the answer to "is this code correct" in two
places that can disagree, and move a security decision out of the database that
already enforces every limit around it.

**Retries.** There is no outbox behind SMS the way there is behind email. A
verification code is worth something for ten minutes and a user is watching the
button, so a failed send is reported to them rather than queued — and because
`request_phone_verification()` commits the code and starts the 60-second cooldown
*before* anything is sent (a provider that never answers must not be able to hand
out unlimited codes), a failed send is a user briefly unable to ask again. The
error copy says how long.

**Delivery webhooks.** MSG91 can POST delivery reports to a callback URL. Nothing
subscribes to one: the useful case is knowing an operator dropped a code, and
`/admin` has no screen that would show it. §7's report page answers the same
question for one number, which is the volume of the question today.
