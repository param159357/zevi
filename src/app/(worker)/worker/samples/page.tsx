import type { Metadata } from "next";
import Link from "next/link";

import { Alert, type AlertTone } from "@/components/ui/Alert";
import { CategorySamples } from "@/components/workers/CategorySamples";
import { SubmitApplication } from "@/components/workers/SubmitApplication";
import { requireRole } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";
import {
  MAX_APPLICATION_ATTEMPTS,
  SAMPLE_MAX_PER_CATEGORY,
  SAMPLE_MIN_PER_CATEGORY,
} from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatTime } from "@/lib/utils/format";
import { loadSampleWorkspace } from "@/lib/workers/queries";
import type { WorkerApplication } from "@/lib/workers/types";

export const metadata: Metadata = { title: "Your samples · Zevi" };

/**
 * Samples and the approval gate (spec §6). Three per category minimum, six
 * maximum, one line each, and an explicit claim of authorship — then an admin
 * decides within 24 hours.
 */
export default async function WorkerSamplesPage() {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const workspace = await loadSampleWorkspace(supabase, context.user.id);
  const banner = describeApplication(workspace.application);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Your samples</h1>
        <p className="text-muted text-sm">
          {SAMPLE_MIN_PER_CATEGORY} to {SAMPLE_MAX_PER_CATEGORY} pieces per category, each
          with a line saying what it was and what you did. Show finished work you were
          paid for or would be happy to be judged on.
        </p>
      </div>

      {banner ? <Alert tone={banner.tone}>{banner.message}</Alert> : null}

      {workspace.categories.length === 0 ? (
        <div className="border-border space-y-3 rounded-xl border p-4">
          <p className="text-sm">You haven&apos;t chosen any categories yet.</p>
          <Link
            href={AUTH_ROUTES.workerCategories}
            className="text-foreground inline-block text-sm underline underline-offset-4"
          >
            Choose your categories
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {workspace.categories.map((category) => (
            <CategorySamples
              key={category.id}
              workerId={context.user.id}
              category={category}
              locked={workspace.locked}
            />
          ))}
        </div>
      )}

      {workspace.locked || workspace.categories.length === 0 ? null : (
        <SubmitApplication
          ready={workspace.readyToSubmit}
          resubmission={workspace.application?.status === "rejected"}
        />
      )}

      <p className="text-muted text-xs">
        Changing your categories?{" "}
        <Link href={AUTH_ROUTES.workerCategories} className="underline underline-offset-4">
          Pick them again
        </Link>{" "}
        — every category needs its own samples before you can take work in it.
      </p>
    </div>
  );
}

/** What the worker is told about where their application stands. */
function describeApplication(
  application: WorkerApplication | null,
): { tone: AlertTone; message: string } | null {
  if (!application) return null;

  switch (application.status) {
    case "submitted":
      return {
        tone: "info",
        message: application.slaDueAt
          ? `In review. We aim to have decided by ${formatDate(application.slaDueAt)}, ${formatTime(application.slaDueAt)}. Your samples are locked until then.`
          : "In review. Your samples are locked until we've decided.",
      };

    // Approve-with-flag is watched on the first delivery (spec §6). That is a
    // note for the reviewer, not a label to hang on someone who was approved.
    case "approved":
    case "approved_with_flag":
      return {
        tone: "success",
        message: "Approved. Jobs in your categories are showing in your feed.",
      };

    case "rejected": {
      const reason = application.decisionReason
        ? ` Reason: ${application.decisionReason}`
        : "";

      if (application.attempt >= MAX_APPLICATION_ATTEMPTS) {
        return {
          tone: "error",
          message: `Not approved.${reason} This was your second attempt, so write to support if you think we've got it wrong.`,
        };
      }

      const when = application.resubmitAfter
        ? ` You can replace your samples and try once more from ${formatDate(application.resubmitAfter)}.`
        : " You can replace your samples and try once more.";

      return { tone: "error", message: `Not approved.${reason}${when}` };
    }

    case "draft":
    case "withdrawn":
      return null;
  }
}
