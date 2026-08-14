"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { AttachmentUploader } from "@/components/jobs/AttachmentUploader";
import { CategoryTiles } from "@/components/jobs/CategoryTiles";
import { FeeBreakdown } from "@/components/jobs/FeeBreakdown";
import { SaveState, type SaveStatus } from "@/components/jobs/SaveState";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { TextField } from "@/components/ui/TextField";
import {
  AUTOSAVE_DEBOUNCE_MS,
  DEFAULT_MAX_UPLOAD_BYTES,
  DESCRIPTION_MAX_LENGTH,
  JOB_ROUTES,
  MAX_BUDGET_PAISE,
  MIN_BUDGET_PAISE,
  TITLE_MAX_LENGTH,
} from "@/lib/constants/jobs";
import { discardJobDraft, publishJob, saveJobDraft } from "@/lib/jobs/actions";
import type {
  EditableJob,
  FieldErrors,
  JobAttachment,
  JobFormValues,
  PostableCategory,
} from "@/lib/jobs/types";
import {
  deadlineDateFromIso,
  deadlineWindow,
  draftBudgetPaise,
} from "@/lib/jobs/validation";
import { type CommissionSlab, priceJob } from "@/lib/money/commission";
import { formatDateShort } from "@/lib/utils/format";
import { formatPaiseCompact, paiseToRupeeInput } from "@/lib/utils/money";

/**
 * The posting form (spec §5).
 *
 * Everything is one Client Component because every field feeds two things that
 * have to stay in step: the autosave, and the price. A budget keystroke changes
 * what the client will pay *and* how long a deadline they may set, and splitting
 * that across a server round trip would make both feel broken.
 *
 * Autosave writes a real `jobs` row in 'draft' — there is no separate drafts
 * table — from the first keystroke. That is why migration 0022 lets a draft be
 * incomplete: the minute before a brief is finished is exactly when a closed
 * tab hurts most.
 */
export function JobPostForm({
  ownerId,
  categories,
  slabs,
  taxRateBps,
  job = null,
  attachments = [],
}: {
  ownerId: string;
  categories: PostableCategory[];
  slabs: CommissionSlab[];
  taxRateBps: number;
  job?: EditableJob | null;
  attachments?: JobAttachment[];
}) {
  const router = useRouter();
  const isLive = job !== null && job.status !== "draft";

  const [values, setValues] = useState<JobFormValues>(() => ({
    categoryId: job?.categoryId ?? null,
    postedAsOther: job?.postedAsOther ?? false,
    title: job?.title ?? "",
    description: job?.description ?? "",
    budget: job?.budgetPaise != null ? paiseToRupeeInput(job.budgetPaise) : "",
    deadline: deadlineDateFromIso(job?.deadlineAt ?? null),
  }));

  const [files, setFiles] = useState<JobAttachment[]>(attachments);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(job?.updatedAt ?? null);
  const [submitting, startSubmit] = useTransition();

  const [jobId, setJobId] = useState<string | null>(job?.id ?? null);
  const jobIdRef = useRef<string | null>(job?.id ?? null);
  const valuesRef = useRef(values);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const snapshot = JSON.stringify(values);
  const lastSavedRef = useRef(snapshot);

  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  /**
   * One save at a time. A second change while a save is in flight sets a flag
   * rather than starting a second request — two overlapping writes can land out
   * of order, and the loser silently wins.
   */
  const save = useCallback(async (): Promise<string | null> => {
    if (inFlightRef.current) {
      queuedRef.current = true;
      return jobIdRef.current;
    }

    inFlightRef.current = true;
    setSaveStatus("saving");

    try {
      do {
        queuedRef.current = false;

        const payload = valuesRef.current;
        const attempted = JSON.stringify(payload);
        const result = await saveJobDraft({ ...payload, jobId: jobIdRef.current });

        if (result.ok) {
          jobIdRef.current = result.jobId;
          setJobId(result.jobId);
          lastSavedRef.current = attempted;
          setSavedAt(result.savedAt);
          setSaveStatus("saved");
          setFieldErrors({});
          setFormError(null);
        } else {
          setSaveStatus("error");
          setFieldErrors(result.fieldErrors ?? {});
          setFormError(result.error ?? null);
          return jobIdRef.current;
        }
      } while (queuedRef.current);
    } finally {
      inFlightRef.current = false;
    }

    return jobIdRef.current;
  }, []);

  useEffect(() => {
    if (snapshot === lastSavedRef.current) return;

    const timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [snapshot, save]);

  // Once a draft has a row, put its id in the address bar: a reload or a
  // reopened tab then resumes it rather than starting a second draft.
  useEffect(() => {
    if (jobId && !job) {
      window.history.replaceState(null, "", JOB_ROUTES.edit(jobId));
    }
  }, [jobId, job]);

  const ensureJobId = useCallback(
    async () => jobIdRef.current ?? (await save()),
    [save],
  );

  function update(patch: Partial<JobFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
  }

  const budgetPaise = draftBudgetPaise(values.budget);
  const deadlineRange = deadlineWindow({
    budgetPaise: budgetPaise ?? MIN_BUDGET_PAISE,
    publishedAt: job?.publishedAt ?? null,
  });

  /** Repricing can shrink the deadline cap out from under a chosen date. */
  function updateBudget(next: string) {
    const paise = draftBudgetPaise(next);
    const nextWindow = deadlineWindow({
      budgetPaise: paise ?? MIN_BUDGET_PAISE,
      publishedAt: job?.publishedAt ?? null,
    });

    setValues((current) => ({
      ...current,
      budget: next,
      deadline:
        current.deadline && current.deadline > nextWindow.maxDate
          ? nextWindow.maxDate
          : current.deadline,
    }));
  }

  const price =
    budgetPaise !== null && budgetPaise >= MIN_BUDGET_PAISE && budgetPaise <= MAX_BUDGET_PAISE
      ? priceJob({ budgetPaise, slabs, taxRateBps })
      : null;

  const selectedCategory = values.postedAsOther
    ? null
    : (categories.find((category) => category.id === values.categoryId) ?? null);
  const maxUploadBytes = selectedCategory?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  function submit() {
    setFormError(null);
    setFieldErrors({});

    startSubmit(async () => {
      // Publishing sends what is on screen rather than what the last autosave
      // caught, so a fast click after a fast edit posts the right brief.
      const result = isLive
        ? await saveJobDraft({ ...valuesRef.current, jobId: jobIdRef.current })
        : await publishJob({ ...valuesRef.current, jobId: jobIdRef.current });

      if (result.ok === true) {
        jobIdRef.current = result.jobId;
        lastSavedRef.current = JSON.stringify(valuesRef.current);
        setSavedAt(result.savedAt);
        setSaveStatus("saved");
        return;
      }

      setFieldErrors(result.fieldErrors ?? {});
      setFormError(result.error ?? null);
      setSaveStatus("error");
    });
  }

  function discard() {
    if (!jobIdRef.current) {
      router.push(JOB_ROUTES.dashboard);
      return;
    }
    const confirmed = window.confirm(
      "Discard this draft? The brief and its files go with it.",
    );
    if (!confirmed) return;

    startSubmit(async () => {
      const result = await discardJobDraft(jobIdRef.current ?? "");
      if (result.ok) router.push(JOB_ROUTES.dashboard);
      else setFormError(result.error);
    });
  }

  return (
    <form
      className="space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {formError ? <Alert tone="error">{formError}</Alert> : null}

      <CategoryTiles
        categories={categories}
        selectedId={values.categoryId}
        postedAsOther={values.postedAsOther}
        error={fieldErrors.categoryId}
        onSelect={(categoryId) => update({ categoryId, postedAsOther: false })}
        onSelectOther={() => update({ categoryId: null, postedAsOther: true })}
      />

      <TextField
        name="title"
        label="Title"
        hint="One line a worker can scan in the feed."
        placeholder="12-slide investor deck from an existing draft"
        maxLength={TITLE_MAX_LENGTH}
        value={values.title}
        error={fieldErrors.title}
        onChange={(event) => update({ title: event.target.value })}
      />

      <TextArea
        name="description"
        label="What needs doing"
        hint="What the work is, what you'll provide, and what finished looks like. Specific briefs get better opt-ins and fewer disputes."
        placeholder="I have a 12-slide deck in Google Slides that needs redesigning to our brand…"
        maxLength={DESCRIPTION_MAX_LENGTH}
        rows={8}
        value={values.description}
        error={fieldErrors.description}
        footer={`${values.description.length.toLocaleString("en-IN")} / ${DESCRIPTION_MAX_LENGTH.toLocaleString("en-IN")}`}
        onChange={(event) => update({ description: event.target.value })}
      />

      <AttachmentUploader
        ownerId={ownerId}
        jobId={jobId}
        attachments={files}
        maxUploadBytes={maxUploadBytes}
        ensureJobId={ensureJobId}
        onChange={setFiles}
      />

      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          name="budget"
          label="Budget"
          prefix="₹"
          inputMode="decimal"
          placeholder="1500"
          hint={`${formatPaiseCompact(MIN_BUDGET_PAISE)} minimum, ${formatPaiseCompact(MAX_BUDGET_PAISE)} maximum for now.`}
          value={values.budget}
          error={fieldErrors.budget}
          onChange={(event) => updateBudget(event.target.value)}
        />

        <TextField
          name="deadline"
          label="Deadline"
          type="date"
          min={deadlineRange.minDate}
          max={deadlineRange.maxDate}
          hint={
            deadlineRange.maxDate >= deadlineRange.minDate
              ? `Up to ${deadlineRange.capDays} days at this budget — ${formatDateShort(`${deadlineRange.maxDate}T12:00:00Z`)} at the latest.`
              : "This job has reached its deadline cap."
          }
          value={values.deadline}
          error={fieldErrors.deadline}
          onChange={(event) => update({ deadline: event.target.value })}
        />
      </div>

      {price ? (
        <FeeBreakdown price={price} />
      ) : (
        <p className="text-muted text-sm">
          Set a budget and we&apos;ll show you exactly what you pay, fee and GST on
          their own lines.
        </p>
      )}

      <div className="border-border flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <SaveState status={saveStatus} savedAt={savedAt} />

        <div className="flex items-center gap-3">
          {isLive ? null : (
            <Button variant="ghost" onClick={discard} disabled={submitting}>
              Discard
            </Button>
          )}
          <Button type="submit" fullWidth={false} disabled={submitting}>
            {submitting
              ? isLive
                ? "Saving…"
                : "Posting…"
              : isLive
                ? "Save changes"
                : "Post this job"}
          </Button>
        </div>
      </div>

      <p className="text-muted text-xs">
        Posting is free. You&apos;ll see who opts in, pick one, and pay then — the
        money is held until you accept the work.
      </p>
    </form>
  );
}
