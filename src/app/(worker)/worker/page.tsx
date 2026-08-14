import type { Metadata } from "next";
import Link from "next/link";

import { requireRole } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";
import { APPROVAL_SLA_HOURS, WORKER_ROUTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils/format";
import { countsTowardMinimum, loadSampleWorkspace } from "@/lib/workers/queries";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Your work · Zevi" };

/**
 * Spec §6 puts the category-filtered feed, opt-ins, deliveries and earnings
 * here. Until a worker is approved none of that is reachable, so for now this
 * is the onboarding checklist and an honest answer to "what happens next".
 */
export default async function WorkerHomePage() {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const workspace = await loadSampleWorkspace(supabase, context.user.id);

  const names = workspace.categories.map((category) => category.name);
  const sampleCount = workspace.categories.reduce(
    (total, category) => total + category.samples.filter(countsTowardMinimum).length,
    0,
  );
  const application = workspace.application;
  const approved =
    workspace.workerStatus === "approved" || workspace.workerStatus === "approved_with_flag";

  function describeApproval(): string {
    if (approved) return "Approved — jobs in your categories show in your feed.";

    switch (application?.status) {
      case "submitted":
        return application.slaDueAt
          ? `In review. We aim to decide by ${formatDate(application.slaDueAt)}.`
          : "In review.";
      case "rejected":
        return "Not approved. Replace your samples and try once more.";
      default:
        return `${APPROVAL_SLA_HOURS}-hour turnaround once your samples are in.`;
    }
  }

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
      linkLabel: names.length > 0 ? "Change" : "Choose now",
    },
    {
      label: "Add samples for review",
      detail:
        sampleCount > 0
          ? `${sampleCount} ${sampleCount === 1 ? "sample" : "samples"} across ${names.length} ${names.length === 1 ? "category" : "categories"}`
          : "Three per category, minimum",
      done: workspace.readyToSubmit || workspace.locked,
      href: WORKER_ROUTES.samples,
      linkLabel: workspace.locked ? "View" : sampleCount > 0 ? "Continue" : "Add samples",
    },
    {
      label: "Admin approval",
      detail: describeApproval(),
      done: approved,
      href: WORKER_ROUTES.samples,
      linkLabel: application?.status === "rejected" ? "See why" : undefined,
    },
  ];

  const remaining = steps.filter((step) => !step.done).length;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {context.profile.display_name ?? context.profile.full_name}
        </h1>
        <p className="text-muted text-sm">
          {approved
            ? "You're approved. The job feed lands here next."
            : remaining === 1
              ? "One step left before jobs start showing up in your feed."
              : `${remaining} steps left before jobs start showing up in your feed.`}
        </p>
      </div>

      <ol className="border-border divide-border divide-y rounded-xl border">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-3 px-4 py-3.5">
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                step.done ? "border-success text-success" : "border-border text-muted",
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
              {step.href && step.linkLabel ? (
                <Link
                  href={step.href}
                  className="text-foreground inline-block text-xs underline underline-offset-4"
                >
                  {step.linkLabel}
                </Link>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
