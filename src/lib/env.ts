/**
 * Environment access.
 *
 * Read env vars through these helpers, never `process.env` directly — a missing
 * variable should fail loudly at startup rather than surface as a confusing
 * runtime error deep inside a request.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * True when the Supabase public credentials are present. Lets setup-phase code
 * degrade instead of throwing before the project has been created.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** Safe to reference from browser code. */
export const publicEnv = {
  get supabaseUrl() {
    return required(
      "NEXT_PUBLIC_SUPABASE_URL",
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
  },
  get supabaseAnonKey() {
    return required(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  },
  /** Razorpay Checkout opens with this. Public by design — it identifies the
   *  merchant and authorises nothing; the secret never leaves the server. */
  get razorpayKeyId() {
    return required(
      "NEXT_PUBLIC_RAZORPAY_KEY_ID",
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    );
  },
};

/**
 * Absolute origin of this deployment, used to build the links Supabase puts in
 * confirmation emails. Those links have to be on the project's redirect allow
 * list (Supabase dashboard → Authentication → URL Configuration) or Supabase
 * quietly falls back to the Site URL.
 */
export function getSiteUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);

  return (configured ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * True when Razorpay is configured. Payment is the one thing a client cannot be
 * shown a half-working version of, so the shortlist reads this and says plainly
 * that picking is unavailable rather than opening a checkout that cannot settle.
 */
export function isRazorpayConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
  );
}

/**
 * True when a worker can actually be put through KYC (spec §6): Razorpay's keys,
 * the RazorpayX account the penny drop is debited from, and the pepper the
 * stored PAN and account hashes are keyed with.
 *
 * Read by the KYC screen, which says plainly that verification is unavailable
 * rather than taking a worker's PAN and bank details and doing nothing with
 * them. Collecting identity documents you cannot verify is worse than not
 * collecting them.
 */
export function isKycConfigured(): boolean {
  return Boolean(
    isRazorpayConfigured() &&
      process.env.RAZORPAY_X_ACCOUNT_NUMBER &&
      process.env.KYC_HASH_PEPPER,
  );
}

/**
 * True when the PAN half of spec §6's verification can run.
 *
 * Separate from `isKycConfigured` because it gates a different thing. Razorpay's
 * PAN check is sold under contract rather than published with the payment APIs,
 * so its endpoint is configuration here instead of a constant — and without it
 * the platform can still verify a worker whose lifetime earnings are under the
 * ₹5,000 line, which is exactly the case spec §6 says UPI alone covers. Past
 * that line a PAN is mandatory, and `submitWorkerKyc` refuses rather than
 * recording an unverified one.
 */
export function isPanVerificationConfigured(): boolean {
  return Boolean(isRazorpayConfigured() && process.env.RAZORPAY_PAN_VERIFY_URL);
}

/**
 * True when SES can actually send (spec §15).
 *
 * Read by `lib/email/send.ts`, which prints to the console in development and
 * refuses in production rather than dropping a receipt on the floor. Deliberately
 * *not* read by anything that enqueues: an email nobody can send yet still
 * belongs in the outbox, where it is visible and can go out once the domain is
 * verified. Silence is the failure mode spec §15 is warning about.
 */
export function isEmailConfigured(): boolean {
  return Boolean(
    process.env.SES_REGION &&
      process.env.SES_ACCESS_KEY_ID &&
      process.env.SES_SECRET_ACCESS_KEY &&
      process.env.SES_FROM_ADDRESS,
  );
}

/**
 * Server-only. Importing this from a Client Component leaks secrets into the
 * browser bundle — don't.
 */
export const serverEnv = {
  get supabaseServiceRoleKey() {
    return required(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
  },
  /**
   * The key id is public by design — Razorpay Checkout needs it in the browser
   * to open, and it authorises nothing on its own. It is read here as well as
   * from `publicEnv` so server code can pair it with the secret in one place.
   */
  get razorpayKeyId() {
    return required(
      "NEXT_PUBLIC_RAZORPAY_KEY_ID",
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    );
  },
  get razorpayKeySecret() {
    return required("RAZORPAY_KEY_SECRET", process.env.RAZORPAY_KEY_SECRET);
  },
  /**
   * Set on the webhook in the Razorpay dashboard, not derivable from the API
   * keys. Without it the webhook route refuses every request rather than
   * trusting an unverified body — an unsigned "payment captured" is exactly the
   * message an attacker would send.
   */
  get razorpayWebhookSecret() {
    return required(
      "RAZORPAY_WEBHOOK_SECRET",
      process.env.RAZORPAY_WEBHOOK_SECRET,
    );
  },
  /**
   * The bearer token on the auto-accept sweep. Vercel Cron sends whatever is in
   * this variable as `Authorization: Bearer …`; the route refuses every request
   * while it is unset, because an open endpoint that completes jobs and releases
   * escrow is an open endpoint that pays people early.
   */
  get cronSecret() {
    return required("CRON_SECRET", process.env.CRON_SECRET);
  },
  /**
   * The RazorpayX account a penny drop is debited from. Razorpay's fund account
   * validation names it as `source_account_number`; it is the platform's own
   * current account, not anything belonging to a worker.
   */
  get razorpayXAccountNumber() {
    return required(
      "RAZORPAY_X_ACCOUNT_NUMBER",
      process.env.RAZORPAY_X_ACCOUNT_NUMBER,
    );
  },
  /**
   * Razorpay's PAN verification endpoint, in full.
   *
   * A URL rather than a path because, unlike the payment APIs, this one is not
   * published — it is enabled per merchant and the host and version come with
   * the contract. Guessing it would mean shipping code that 404s in production
   * and looks wired until the day someone crosses ₹5,000.
   */
  get razorpayPanVerifyUrl() {
    return required("RAZORPAY_PAN_VERIFY_URL", process.env.RAZORPAY_PAN_VERIFY_URL);
  },
  /**
   * The key the stored PAN and payout-destination hashes are HMAC'd with.
   *
   * It is not in the database on purpose. `worker_kyc.pan_hash` exists to spot
   * one PAN on two accounts and `payout_methods.destination_hash` to spot two
   * accounts paying into one place — neither needs to be reversible, and a plain
   * digest of a PAN is a space small enough to enumerate. With the pepper held
   * here, a copy of the database is not a copy of anyone's PAN.
   *
   * Changing it orphans every existing hash: duplicates stop being detectable
   * across the change, and nothing else breaks.
   */
  get kycHashPepper() {
    return required("KYC_HASH_PEPPER", process.env.KYC_HASH_PEPPER);
  },

  /**
   * The SES region — and note the names: `SES_*`, not `AWS_*`.
   *
   * Two reasons. A Vercel function runs on Lambda, whose runtime sets
   * `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for its own
   * execution role; ours would be read in some contexts and quietly shadowed in
   * others. And the credentials these name should belong to an IAM user holding
   * `ses:SendEmail` and nothing else, so calling them "the AWS keys" describes a
   * blast radius we do not want anyone to assume they have.
   *
   * SES is regional and an identity verified in one region is not verified in
   * another, so this has to match wherever the domain was set up — `ap-south-1`
   * for a platform whose users are all in India.
   */
  get sesRegion() {
    return required("SES_REGION", process.env.SES_REGION);
  },
  get sesAccessKeyId() {
    return required("SES_ACCESS_KEY_ID", process.env.SES_ACCESS_KEY_ID);
  },
  get sesSecretAccessKey() {
    return required("SES_SECRET_ACCESS_KEY", process.env.SES_SECRET_ACCESS_KEY);
  },
  /**
   * The From address, which must be an identity SES has verified — either the
   * address itself or its domain. `Zevi <no-reply@zevi.in>` is accepted as well
   * as a bare address; SES parses the display-name form.
   *
   * Sending from a domain whose DKIM records are not published is the specific
   * way spec §15's warning comes true: SES accepts the message, the recipient's
   * provider fails the DMARC check, and the mail is filed as spam without
   * anybody being told.
   */
  get sesFromAddress() {
    return required("SES_FROM_ADDRESS", process.env.SES_FROM_ADDRESS);
  },
};
