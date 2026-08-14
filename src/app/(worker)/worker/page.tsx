import type { Metadata } from "next";
import Link from "next/link";

import { requireRole } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Your work · Zevi" };

/**
 * Placeholder. Spec §6 puts the category-filtered feed, opt-ins, deliveries and
 * earnings here. For now it is the onboarding checklist: categories are done at
 * signup, samples and admin approval are the next things to build.
 */
export default async function WorkerHomePage() {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const { data: links, error: linkError } = await supabase
    .from("worker_categories")
    .select("category_id")
    .eq("worker_id", context.user.id);

  if (linkError) throw new Error(`Could not load your categories: ${linkError.message}`);

  const categoryIds = (links ?? []).map((row) => row.category_id);

  const { data: categories } =
    categoryIds.length > 0
      ? await supabase.from("categories").select("name").in("id", categoryIds)
      : { data: [] };

  const names = (categories ?? []).map((category) => category.name);

  const steps = [
    {
      label: "Verify your email and mobile",
      detail: context.profile.email,
      done: true,
    },
    {
      label: "Choose your categories",
      detail: names.length > 0 ? names.join(", ") : "Not chosen yet",
      done: names.length > 0,
      href: AUTH_ROUTES.workerCategories,
    },
    {
      label: "Add samples for review",
      detail: "Three per category, minimum. Coming next.",
      done: false,
    },
    {
      label: "Admin approval",
      detail: "24-hour turnaround once your samples are in.",
      done: false,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {context.profile.display_name ?? context.profile.full_name}
        </h1>
        <p className="text-muted text-sm">
          Two steps left before jobs start showing up in your feed.
        </p>
      </div>

      <ol className="border-border divide-border divide-y rounded-xl border">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-3 px-4 py-3.5">
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                step.done
                  ? "border-success text-success"
                  : "border-border text-muted",
              )}
            >
              {step.done ? "✓" : "–"}
            </span>

            <span className="space-y-0.5">
              <span className="block text-sm font-medium">
                {step.label}
                <span className="sr-only">{step.done ? " — done" : " — not done yet"}</span>
              </span>
              <span className="text-muted block text-xs">{step.detail}</span>
              {step.href ? (
                <Link
                  href={step.href}
                  className="text-foreground inline-block text-xs underline underline-offset-4"
                >
                  {step.done ? "Change" : "Choose now"}
                </Link>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
