/**
 * The events that send mail — spec §15's list, joined to the code that already
 * exists.
 *
 * **Server-only, and deliberately not a Server Action.**
 *
 * Everything here is shaped the same way: one function per event, named for the
 * event and not for the template; it reads what its templates need with the
 * service-role client, queues them, and returns nothing. Call sites are one
 * line at the end of an action that has already succeeded.
 *
 * Three rules hold throughout.
 *
 * **Nothing here can fail a caller.** Every function is wrapped in `notify`,
 * which catches and logs. These are called after money has moved, from
 * transactions that are already committed — a receipt that could not be
 * composed must never unwind an acceptance, and there is nothing the caller
 * could do about it anyway. What it must not do is fail *silently*, which is
 * why the log line names the event and the job.
 *
 * **Every figure comes from a row somebody else wrote.** `job_financials` is
 * frozen at assignment and is where the receipt's numbers come from; the names
 * come from `public_profiles`, the projection that exists to be read by the
 * other side. Nothing in this file computes an amount — a commission
 * recalculated here to put in an email is a second implementation of spec §8
 * that will one day disagree with the first.
 *
 * **Every email is deduplicated by its event.** The keys are written out at
 * each call rather than generated, because they are the thing standing between
 * a client and two receipts for one payment — the browser and the Razorpay
 * webhook both settle, in either order, and both queue this.
 */

import { autoAcceptWindowLabel } from "@/lib/constants/deliveries";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { DISPUTE_ROUTES } from "@/lib/constants/disputes";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { absoluteUrl } from "@/lib/email/links";
import { queueEmail } from "@/lib/email/outbox";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { formatWhen, jobReference } from "@/lib/utils/format";

/** The one place an email failure stops. */
async function notify(event: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    console.error(`[email] ${event}: ${reason}`);
  }
}

type JobContext = {
  jobId: string;
  jobRef: string;
  title: string;
  budgetPaise: number;
  clientId: string;
  workerId: string | null;
  deadlineLabel: string | null;
  clientName: string;
  workerName: string;
};

/**
 * Who and what a job email is about.
 *
 * The display names are the ones each side is allowed to see —
 * `public_profiles.display_name` is a first name, not the legal name on an ID
 * (spec §6). The fallbacks are deliberately generic rather than an id: an email
 * that opens "Hi 4f3c2b91" is worse than one that opens "your worker".
 */
async function loadJobContext(jobId: string): Promise<JobContext | null> {
  const admin = createServiceRoleClient();

  const { data: job, error } = await admin
    .from("jobs")
    .select("id, title, budget_paise, client_id, assigned_worker_id, deadline_at")
    .eq("id", jobId)
    .maybeSingle();

  if (error || !job) return null;

  const ids = [job.client_id, job.assigned_worker_id].filter(
    (id): id is string => typeof id === "string",
  );

  const { data: names } = await admin
    .from("public_profiles")
    .select("profile_id, display_name")
    .in("profile_id", ids);

  const byId = new Map((names ?? []).map((row) => [row.profile_id, row.display_name]));

  return {
    jobId: job.id,
    jobRef: jobReference(job.id),
    title: job.title ?? "your job",
    // Nullable only while a job is a draft (0022), which is long before any of
    // this. The fallback keeps the type honest rather than asserting.
    budgetPaise: job.budget_paise ?? 0,
    clientId: job.client_id,
    workerId: job.assigned_worker_id,
    deadlineLabel: job.deadline_at ? formatWhen(job.deadline_at) : null,
    clientName: byId.get(job.client_id) ?? "Your client",
    workerName:
      (job.assigned_worker_id ? byId.get(job.assigned_worker_id) : null) ?? "Your worker",
  };
}

/**
 * Selection — spec §4 step 5. Two emails, one event: the client's receipt and
 * the worker's "you've been picked".
 *
 * Queued from `settleCapturedPayment`, which both the browser and the webhook
 * reach, so both keys are the job rather than the moment.
 */
export async function notifyJobAssigned(jobId: string): Promise<void> {
  await notify(`job assigned ${jobId}`, async () => {
    const context = await loadJobContext(jobId);
    if (!context || !context.workerId) return;

    const admin = createServiceRoleClient();

    // The price as it was frozen before the card was charged. If this row is
    // missing something has gone very wrong upstream — and an email with a
    // guessed total would be the least of it, so the receipt is skipped.
    const { data: financials } = await admin
      .from("job_financials")
      .select(
        "budget_paise, client_commission_paise, client_tax_paise, client_total_paise, worker_net_paise",
      )
      .eq("job_id", jobId)
      .maybeSingle();

    if (!financials) {
      console.error(`[email] job ${jobId} was assigned with no job_financials row`);
      return;
    }

    await queueEmail({
      template: "payment_received",
      profileId: context.clientId,
      jobId,
      dedupeKey: `job:${jobId}:payment_received`,
      payload: {
        jobRef: context.jobRef,
        jobTitle: context.title,
        workerName: context.workerName,
        budgetPaise: financials.budget_paise,
        commissionPaise: financials.client_commission_paise,
        taxPaise: financials.client_tax_paise,
        totalPaise: financials.client_total_paise,
        deadlineLabel: context.deadlineLabel,
        url: absoluteUrl(JOB_ROUTES.review(jobId)),
      },
    });

    await queueEmail({
      template: "worker_selected",
      profileId: context.workerId,
      jobId,
      dedupeKey: `job:${jobId}:worker_selected`,
      payload: {
        jobRef: context.jobRef,
        jobTitle: context.title,
        clientName: context.clientName,
        budgetPaise: financials.budget_paise,
        netPaise: financials.worker_net_paise,
        deadlineLabel: context.deadlineLabel,
        url: absoluteUrl(WORKER_ROUTES.deliver(jobId)),
      },
    });
  });
}

/**
 * The first worker opts in — spec §15's "shortlist ready".
 *
 * Once per job, and the dedupe key is what makes that true: every opt-in calls
 * this and the second one queues nothing. A client emailed on each of nine
 * opt-ins learns to filter us, which costs them the tenth.
 */
export async function notifyShortlistReady(jobId: string): Promise<void> {
  await notify(`shortlist ready ${jobId}`, async () => {
    const context = await loadJobContext(jobId);
    if (!context) return;

    await queueEmail({
      template: "shortlist_ready",
      profileId: context.clientId,
      jobId,
      dedupeKey: `job:${jobId}:shortlist_ready`,
      payload: {
        jobRef: context.jobRef,
        jobTitle: context.title,
        url: absoluteUrl(JOB_ROUTES.shortlist(jobId)),
      },
    });
  });
}

/** Spec §4 step 7. The deadline quoted is the one stored on the delivery. */
export async function notifyWorkDelivered(input: {
  jobId: string;
  deliveryId: string;
  autoAcceptAt: string;
  fileCount: number;
}): Promise<void> {
  await notify(`work delivered ${input.deliveryId}`, async () => {
    const context = await loadJobContext(input.jobId);
    if (!context) return;

    await queueEmail({
      template: "work_delivered",
      profileId: context.clientId,
      jobId: input.jobId,
      // The delivery, not the job: a revision produces a second delivery and a
      // second email, which is the correct number.
      dedupeKey: `delivery:${input.deliveryId}:delivered`,
      payload: {
        jobRef: context.jobRef,
        jobTitle: context.title,
        workerName: context.workerName,
        fileCount: input.fileCount,
        // Spec §5's window in words, from the same budget threshold
        // `stamp_auto_accept_deadline()` used to set the instant beside it.
        windowLabel: autoAcceptWindowLabel(context.budgetPaise),
        deadlineLabel: formatWhen(input.autoAcceptAt),
        url: absoluteUrl(JOB_ROUTES.review(input.jobId)),
      },
    });
  });
}

/**
 * Acceptance, by a click or by the clock — spec §4 steps 8 and 9.
 *
 * The client is the only recipient, which is spec §15's list rather than an
 * oversight: the worker's essential email about a completed job is "payout
 * sent", when the money actually moves. Between the two they see the earning on
 * their dashboard.
 */
export async function notifyJobCompleted(input: {
  jobId: string;
  autoAccepted: boolean;
}): Promise<void> {
  await notify(`job completed ${input.jobId}`, async () => {
    const context = await loadJobContext(input.jobId);
    if (!context) return;

    const admin = createServiceRoleClient();
    const { data: financials } = await admin
      .from("job_financials")
      .select("budget_paise")
      .eq("job_id", input.jobId)
      .maybeSingle();

    await queueEmail({
      template: "job_completed",
      profileId: context.clientId,
      jobId: input.jobId,
      dedupeKey: `job:${input.jobId}:completed`,
      payload: {
        jobRef: context.jobRef,
        jobTitle: context.title,
        workerName: context.workerName,
        budgetPaise: financials?.budget_paise ?? 0,
        autoAccepted: input.autoAccepted,
        url: absoluteUrl(JOB_ROUTES.review(input.jobId)),
      },
    });
  });
}

/** Spec §5's one free revision, in the worker's inbox. */
export async function notifyRevisionRequested(input: {
  jobId: string;
  deliveryId: string;
  reason: string;
}): Promise<void> {
  await notify(`revision requested ${input.deliveryId}`, async () => {
    const context = await loadJobContext(input.jobId);
    if (!context?.workerId) return;

    await queueEmail({
      template: "revision_requested",
      profileId: context.workerId,
      jobId: input.jobId,
      dedupeKey: `delivery:${input.deliveryId}:revision`,
      payload: {
        jobRef: context.jobRef,
        jobTitle: context.title,
        clientName: context.clientName,
        reason: input.reason,
        url: absoluteUrl(WORKER_ROUTES.deliver(input.jobId)),
      },
    });
  });
}

/**
 * Spec §6's first gate, decided. `approve_with_flag` is an approval — the flag
 * means watched on the first delivery (spec §7), which is an internal matter
 * and not something to tell a worker they are under.
 */
export async function notifyApplicationReviewed(input: {
  applicationId: string;
  workerId: string;
  decision: "approve" | "approve_with_flag" | "reject";
  reason: string;
}): Promise<void> {
  await notify(`application reviewed ${input.applicationId}`, async () => {
    const admin = createServiceRoleClient();

    if (input.decision === "reject") {
      const { data: application } = await admin
        .from("worker_applications")
        .select("resubmit_after")
        .eq("id", input.applicationId)
        .maybeSingle();

      await queueEmail({
        template: "application_rejected",
        profileId: input.workerId,
        dedupeKey: `application:${input.applicationId}:rejected`,
        payload: {
          reason: input.reason,
          resubmitLabel: application?.resubmit_after
            ? formatWhen(application.resubmit_after)
            : null,
          url: absoluteUrl(WORKER_ROUTES.samples),
        },
      });
      return;
    }

    const { data: categories } = await admin
      .from("worker_categories")
      .select("categories(name)")
      .eq("worker_id", input.workerId);

    const names = (categories ?? [])
      .map((row) => row.categories?.name)
      .filter((name): name is string => Boolean(name));

    await queueEmail({
      template: "application_approved",
      profileId: input.workerId,
      dedupeKey: `application:${input.applicationId}:approved`,
      payload: {
        categoriesLabel: names.length > 0 ? listOf(names) : "your categories",
        url: absoluteUrl(WORKER_ROUTES.feed),
      },
    });
  });
}

/**
 * Spec §11. One template, both sides, and `stage` decides the words.
 *
 * Who is told depends on the stage, which is the whole reason this takes a
 * dispute id rather than a recipient. A case being *raised* is news to the
 * other side only — the person who raised it filled in the form. A decision is
 * news to both.
 *
 * **What a decision email does not carry is the decision note.** Spec §7 makes
 * that note mandatory and internal; it is a reviewer writing for other
 * reviewers, and mailing it to both parties would turn every case into an
 * argument with the reasoning. The email says a decision has been made and
 * links to the case, which shows each side their own outcome. The one thing
 * that *is* quoted is the summary the raiser wrote, and only on the way in —
 * the other side can read it on the case anyway, and it is the difference
 * between "there's a dispute" and knowing what it is about.
 */
export async function notifyDisputeUpdate(input: {
  disputeId: string;
  stage: "raised" | "response" | "resolved";
}): Promise<void> {
  await notify(`dispute ${input.stage} ${input.disputeId}`, async () => {
    const admin = createServiceRoleClient();

    const { data: dispute } = await admin
      .from("disputes")
      .select("id, job_id, raised_by, reason_summary")
      .eq("id", input.disputeId)
      .maybeSingle();

    if (!dispute) return;

    const context = await loadJobContext(dispute.job_id);
    if (!context) return;

    const parties = [context.clientId, context.workerId].filter(
      (id): id is string => typeof id === "string",
    );

    // Each stage goes to whoever did *not* write the thing being announced.
    // A case is raised by one side and answered by the other, so those two
    // stages have opposite recipients; a decision is news to both.
    const recipients =
      input.stage === "resolved"
        ? parties
        : input.stage === "raised"
          ? parties.filter((id) => id !== dispute.raised_by)
          : parties.filter((id) => id === dispute.raised_by);

    for (const profileId of recipients) {
      await queueEmail({
        template: "dispute_update",
        profileId,
        jobId: dispute.job_id,
        dedupeKey: `dispute:${dispute.id}:${input.stage}:${profileId}`,
        payload: {
          jobRef: context.jobRef,
          jobTitle: context.title,
          stage: input.stage,
          detail: input.stage === "raised" ? dispute.reason_summary : null,
          url: absoluteUrl(DISPUTE_ROUTES.case(dispute.id)),
        },
      });
    }
  });
}

/** `a, b and c` — for a list in a sentence, where a comma-join reads wrong. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
