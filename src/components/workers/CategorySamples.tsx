"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import {
  ALLOWED_SAMPLE_MIME_TYPES,
  CAPTION_MAX_LENGTH,
  SAMPLE_BUCKET,
  SAMPLE_PREFIX,
} from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/client";
import { hashFile, objectName } from "@/lib/uploads/client";
import { formatBytes } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import {
  createSampleUrl,
  registerWorkerSample,
  removeWorkerSample,
} from "@/lib/workers/actions";
import type { SampleCategory, WorkerSample } from "@/lib/workers/types";

const STATUS_LABELS: Record<WorkerSample["status"], string> = {
  pending: "Waiting on review",
  approved: "Approved",
  rejected: "Not accepted",
  flagged: "Flagged",
};

/**
 * One category's samples: 3 minimum, 6 maximum, a one-line caption each, and
 * the explicit "did you make this alone?" confirmation (spec §6).
 *
 * The list is not held in state. Every action revalidates `/worker/samples`, so
 * the server re-renders it — which also means the counts, the readiness of the
 * submit button and the ceiling all come from the database rather than from
 * whatever this component believed a moment ago.
 */
export function CategorySamples({
  workerId,
  category,
  locked,
}: {
  workerId: string;
  category: SampleCategory;
  /** In review or approved: the portfolio is frozen. */
  locked: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [soleAuthor, setSoleAuthor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busySampleId, setBusySampleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captionError, setCaptionError] = useState<string | null>(null);

  const live = category.samples.filter((sample) => sample.status !== "rejected");
  const rejected = category.samples.filter((sample) => sample.status === "rejected");
  const full = live.length >= category.sampleMax;
  const short = Math.max(category.sampleMin - live.length, 0);

  async function add() {
    setError(null);
    setCaptionError(null);

    if (!file) {
      setError("Choose a file first.");
      return;
    }
    if (!soleAuthor) {
      setError("Confirm you made this yourself.");
      return;
    }
    if (file.size === 0) {
      setError(`${file.name} is empty.`);
      return;
    }
    if (file.size > category.maxUploadBytes) {
      setError(`${file.name} is over the ${formatBytes(category.maxUploadBytes)} limit.`);
      return;
    }
    if (!(ALLOWED_SAMPLE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(
        `We don't accept ${file.name.split(".").pop()?.toUpperCase() ?? "that"} files as samples.`,
      );
      return;
    }

    setBusy(true);

    try {
      const sha256 = await hashFile(file).catch(() => null);
      if (!sha256) {
        setError(`We couldn't read ${file.name}.`);
        return;
      }

      const supabase = createClient();
      const storageKey = `${SAMPLE_PREFIX}/${workerId}/${category.id}/${objectName(file.name)}`;

      const { error: uploadError } = await supabase.storage
        .from(SAMPLE_BUCKET)
        .upload(storageKey, file, { contentType: file.type, upsert: false });

      if (uploadError) {
        console.error("[workers] sample upload failed", uploadError);
        setError(`${file.name} didn't upload. Try again.`);
        return;
      }

      const result = await registerWorkerSample({
        categoryId: category.id,
        storageKey,
        originalName: file.name,
        sha256,
        caption,
        soleAuthor,
      });

      if (!result.ok) {
        setError(result.error);
        setCaptionError(result.fieldErrors?.caption ?? null);
        return;
      }

      setFile(null);
      setCaption("");
      setSoleAuthor(false);
      if (fileRef.current) fileRef.current.value = "";
    } finally {
      setBusy(false);
    }
  }

  async function remove(sampleId: string) {
    setBusySampleId(sampleId);
    setError(null);

    const result = await removeWorkerSample(sampleId);
    setBusySampleId(null);

    if (!result.ok) setError(result.error);
  }

  async function open(sampleId: string) {
    setBusySampleId(sampleId);
    const result = await createSampleUrl(sampleId);
    setBusySampleId(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="border-border space-y-4 rounded-xl border p-4 sm:p-5">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold">{category.name}</h2>
          <p className="text-muted text-xs tabular-nums">
            {live.length} of {category.sampleMax} · {category.sampleMin} minimum
          </p>
        </div>

        {/* Once it is with a reviewer the banner above says where it stands, and
            "ready for review" would be a stale answer to a settled question. */}
        {locked ? null : (
          <p className={cn("text-xs", short > 0 ? "text-danger" : "text-muted")}>
            {short > 0
              ? `${short} more ${short === 1 ? "sample" : "samples"} needed here.`
              : "Ready for review."}
          </p>
        )}

        {category.formatNote ? (
          <p className="text-muted text-xs">{category.formatNote}</p>
        ) : null}
      </header>

      {category.samples.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-lg border">
          {[...live, ...rejected].map((sample) => (
            <li key={sample.id} className="space-y-1 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => void open(sample.id)}
                  disabled={busySampleId === sample.id}
                  className="hover:text-accent min-w-0 flex-1 truncate text-left text-sm underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {sample.name}
                </button>

                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-muted text-xs tabular-nums">
                    {formatBytes(sample.sizeBytes)}
                  </span>
                  {locked ? (
                    <span className="text-muted text-xs">{STATUS_LABELS[sample.status]}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void remove(sample.id)}
                      disabled={busySampleId === sample.id}
                      className="text-muted hover:text-danger text-xs disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>

              <p className="text-muted text-xs">{sample.caption}</p>

              {sample.status === "rejected" ? (
                <p className="text-danger text-xs">
                  Not accepted{sample.rejectionReason ? `: ${sample.rejectionReason}` : "."}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {locked ? null : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              disabled={busy || full}
            >
              {file ? "Choose a different file" : "Choose a file"}
            </Button>

            <span className="text-muted min-w-0 flex-1 truncate text-xs">
              {full
                ? `${category.sampleMax} samples is the most this category takes.`
                : (file?.name ?? `Up to ${formatBytes(category.maxUploadBytes)}.`)}
            </span>
          </div>

          {/* Hidden, and opened by the button above rather than by a label — so
              it needs no id, and generating one only risks a hydration mismatch. */}
          <input
            ref={fileRef}
            type="file"
            accept={ALLOWED_SAMPLE_MIME_TYPES.join(",")}
            className="sr-only"
            disabled={busy || full}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
            }}
          />

          {file && !full ? (
            <>
              <TextField
                name={`caption-${category.id}`}
                label="One line about it"
                hint="What it was, and what you did. A reviewer reads this next to the file."
                value={caption}
                maxLength={CAPTION_MAX_LENGTH}
                disabled={busy}
                error={captionError ?? undefined}
                onChange={(event) => setCaption(event.target.value)}
              />

              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={soleAuthor}
                  disabled={busy}
                  onChange={(event) => setSoleAuthor(event.target.checked)}
                  className="accent-accent mt-0.5 size-4"
                />
                <span>
                  I made this myself.
                  <span className="text-muted block text-xs">
                    Passing off someone else&apos;s work is a permanent ban, and we reverse
                    image search what we can.
                  </span>
                </span>
              </label>

              <Button onClick={() => void add()} disabled={busy || !soleAuthor}>
                {busy ? "Adding…" : "Add sample"}
              </Button>
            </>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
