"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  ATTACHMENT_BUCKET,
  ATTACHMENT_PREFIX,
  MAX_ATTACHMENTS_PER_JOB,
} from "@/lib/constants/jobs";
import { createAttachmentUrl, registerJobAttachment, removeJobAttachment } from "@/lib/jobs/actions";
import type { JobAttachment } from "@/lib/jobs/types";
import { createClient } from "@/lib/supabase/client";
import { hashFile, objectName } from "@/lib/uploads/client";
import { formatBytes } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * Attachments on a brief (spec §5).
 *
 * The object goes straight from the browser to storage — a 500MB source video
 * has no business travelling through a Server Action — and only then does a
 * Server Action turn it into a `files` row, against the size and type storage
 * reports rather than the ones claimed here. `lib/uploads/client` holds the two
 * halves of that shared with the worker sample uploader.
 */
export function AttachmentUploader({
  ownerId,
  jobId,
  attachments,
  maxUploadBytes,
  disabled = false,
  ensureJobId,
  onChange,
}: {
  ownerId: string;
  jobId: string | null;
  attachments: JobAttachment[];
  maxUploadBytes: number;
  disabled?: boolean;
  /** Creates the draft if it doesn't exist yet — a file needs a job to hang off. */
  ensureJobId: () => Promise<string | null>;
  onChange: (attachments: JobAttachment[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = attachments.length + uploading.length;
  const full = total >= MAX_ATTACHMENTS_PER_JOB;

  async function addFiles(picked: File[]) {
    setError(null);

    // Accumulated locally rather than read back from the prop: several files
    // can be picked at once, and the parent's state has not landed by the time
    // the next iteration starts.
    let current = attachments;

    for (const file of picked) {
      if (current.length >= MAX_ATTACHMENTS_PER_JOB) {
        setError(`${MAX_ATTACHMENTS_PER_JOB} files is the limit on one job.`);
        return;
      }
      if (file.size === 0) {
        setError(`${file.name} is empty.`);
        continue;
      }
      if (file.size > maxUploadBytes) {
        setError(`${file.name} is over the ${formatBytes(maxUploadBytes)} limit.`);
        continue;
      }
      if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
        setError(`We don't accept ${file.name.split(".").pop()?.toUpperCase() ?? "that"} files.`);
        continue;
      }

      setUploading((current) => [...current, file.name]);

      try {
        const attachment = await upload(file);
        if (attachment) {
          current = [...current, attachment];
          onChange(current);
        }
      } finally {
        setUploading((current) => current.filter((name) => name !== file.name));
      }
    }
  }

  async function upload(file: File): Promise<JobAttachment | null> {
    const targetJobId = jobId ?? (await ensureJobId());

    if (!targetJobId) {
      setError("We couldn't save the draft, so there's nowhere to put that file yet.");
      return null;
    }

    let sha256: string;
    try {
      sha256 = await hashFile(file);
    } catch {
      setError(`We couldn't read ${file.name}.`);
      return null;
    }

    const supabase = createClient();
    const storageKey = `${ATTACHMENT_PREFIX}/${ownerId}/${targetJobId}/${objectName(file.name)}`;

    const { error: uploadError } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(storageKey, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      console.error("[jobs] upload failed", uploadError);
      setError(`${file.name} didn't upload. Try again.`);
      return null;
    }

    const result = await registerJobAttachment({
      jobId: targetJobId,
      storageKey,
      originalName: file.name,
      sha256,
    });

    if (!result.ok) {
      setError(result.error);
      return null;
    }

    return result.attachment;
  }

  async function remove(fileId: string) {
    if (!jobId) return;

    setBusyFileId(fileId);
    setError(null);

    const result = await removeJobAttachment(jobId, fileId);
    setBusyFileId(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    onChange(attachments.filter((attachment) => attachment.fileId !== fileId));
  }

  async function open(fileId: string) {
    if (!jobId) return;

    setBusyFileId(fileId);
    const result = await createAttachmentUrl(jobId, fileId);
    setBusyFileId(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="space-y-2">
      <p className="block text-sm font-medium">Attachments</p>
      <p className="text-muted text-xs">
        Anything that makes the brief clearer — references, brand assets, source
        files. Up to {MAX_ATTACHMENTS_PER_JOB} files, {formatBytes(maxUploadBytes)} each.
      </p>

      {attachments.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-lg border">
          {attachments.map((attachment) => (
            <li
              key={attachment.fileId}
              className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
            >
              <button
                type="button"
                onClick={() => void open(attachment.fileId)}
                disabled={busyFileId === attachment.fileId}
                className="hover:text-accent min-w-0 truncate text-left underline-offset-2 hover:underline disabled:opacity-50"
              >
                {attachment.name}
              </button>
              <span className="flex shrink-0 items-center gap-3">
                <span className="text-muted text-xs tabular-nums">
                  {formatBytes(attachment.sizeBytes)}
                </span>
                {disabled ? null : (
                  <button
                    type="button"
                    onClick={() => void remove(attachment.fileId)}
                    disabled={busyFileId === attachment.fileId}
                    className="text-muted hover:text-danger text-xs disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {uploading.length > 0 ? (
        <ul className="text-muted space-y-1 text-xs" aria-live="polite">
          {uploading.map((name) => (
            <li key={name} className="truncate">
              Uploading {name}…
            </li>
          ))}
        </ul>
      ) : null}

      {/* Hidden, and opened by the button below rather than by a label — so it
          needs no id, and generating one only risks a hydration mismatch. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
        className="sr-only"
        disabled={disabled || full}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          void addFiles(picked);
        }}
      />

      <Button
        variant="secondary"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || full || uploading.length > 0}
        className={cn("w-full sm:w-auto")}
      >
        {full ? `${MAX_ATTACHMENTS_PER_JOB} files attached` : "Add files"}
      </Button>

      {error ? (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
