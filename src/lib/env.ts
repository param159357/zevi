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
};
