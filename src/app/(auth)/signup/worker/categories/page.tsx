import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/AuthCard";
import { CategoryPicker } from "@/components/auth/CategoryPicker";
import { destinationFor, requireUser } from "@/lib/auth/session";
import { MAX_WORKER_CATEGORIES, NON_WORKER_CATEGORY_SLUGS } from "@/lib/constants/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Choose your categories · Zevi" };

export default async function WorkerCategoriesPage() {
  const context = await requireUser();

  if (context.step === "verify_email" || context.step === "verify_mobile") {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  const supabase = await createClient();

  const { data: categories, error } = await supabase
    .from("categories")
    .select("id, name, description, slug")
    .eq("status", "active")
    .order("position");

  if (error) throw new Error(`Could not load categories: ${error.message}`);

  const { data: existing } = await supabase
    .from("worker_categories")
    .select("category_id")
    .eq("worker_id", context.user.id);

  const pickable = (categories ?? []).filter(
    (category) => !NON_WORKER_CATEGORY_SLUGS.includes(category.slug),
  );

  return (
    <AuthCard
      title="What do you do?"
      description={`Up to ${MAX_WORKER_CATEGORIES} categories. Your rating is kept per category, so pick the ones you'd be happy to be judged on.`}
    >
      <CategoryPicker
        categories={pickable}
        selectedIds={(existing ?? []).map((row) => row.category_id)}
      />
    </AuthCard>
  );
}
