import type { Metadata } from "next";

import { JobPostForm } from "@/components/jobs/JobPostForm";
import { requireRole } from "@/lib/auth/session";
import { loadPostableCategories } from "@/lib/jobs/queries";
import { loadRates } from "@/lib/money/rates";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Post a job · Zevi" };

/**
 * A new post (spec §5). No row exists yet — the first autosave creates one and
 * swaps the address bar to `/post/<id>`, so a reload resumes the draft instead
 * of starting a second one.
 */
export default async function PostJobPage() {
  const context = await requireRole("client");
  const supabase = await createClient();

  const [categories, rates] = await Promise.all([
    loadPostableCategories(supabase),
    loadRates(supabase),
  ]);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Post a job</h1>
        <p className="text-muted text-sm">
          Free to post. Workers in your category opt in, you pick one, and you pay
          then — not now.
        </p>
      </div>

      <JobPostForm
        ownerId={context.user.id}
        categories={categories}
        slabs={rates.slabs}
        taxRateBps={rates.taxRateBps}
      />
    </div>
  );
}
