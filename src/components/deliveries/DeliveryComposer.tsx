"use client";

import { useRef, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import {
  ALLOWED_DELIVERY_MIME_TYPES,
  DELIVERY_BUCKET,
  DELIVERY_NOTE_MAX_LENGTH,
  DELIVERY_PREFIX,
  MAX_FILES_PER_DELIVERY,
  previewKindFor,
} from "@/lib/constants/deliveries";
import {
  openStagedFile,
  registerDeliveryFile,
  removeDeliveryFile,
  submitDelivery,
} from "@/lib/deliveries/actions";
import type { StagedFile } from "@/lib/deliveries/types";
import { createClient } from "@/lib/supabase/client";
import { hashFile, objectName } from "@/lib/uploads/client";
import { formatBytes } from "@/lib/utils/format";

/**
 * Sending the work — spec §6's "all files through the platform, never chat or
 * external links".
 *
 * The object goes straight from the browser to storage, the same way a job
 * attachment and a worker sample do; `lib/uploads/client` is the half the three
 * share. Registering it server-side is what reads back the real size and type,
 * and what builds the watermarked preview.
 *
 * The preview matters enough to say out loud here, per file. A worker who sends
 * a PPTX and nothing else has given their client no way to judge the work before
 * accepting, and the first they will hear about it is a revision request — so
 * the row says so at the moment they add it.
 */
export function DeliveryComposer({
  jobId,
  workerId,
  staged,
  maxUploadBytes,
  attempt,
  autoAcceptWindow,
}: {
  jobId: string;
  workerId: string;
  staged: StagedFile[];
  maxUploadBytes: number;
  /** Which attempt this will be — 1, or 2 after the free revision. */
  attempt: number;
  /** "36 hours" or "3 days", so the button says what it starts. */
  autoAcceptWindow: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<StagedFile[]>(staged);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState<string[]>([]);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const full = files.length + uploading.length >= MAX_FILES_PER_DELIVERY;
  const nothingViewable =
    files.length > 0 && files.every((file) => !file.hasPreview && previewKindFor(file.mimeType) !== "text");

  async function addFiles(picked: File[]) {
    setError(null);

    // Accumulated locally rather than read back from state: several files can be
    // picked at once, and the previous setState has not landed by the time the
    // next iteration starts.
    let current = files;

    for (const file of picked) {
      if (current.length >= MAX_FILES_PER_DELIVERY) {
        setError(`${MAX_FILES_PER_DELIVERY} files is the limit on one delivery.`);
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
      if (!(ALLOWED_DELIVERY_MIME_TYPES as readonly string[]).includes(file.type)) {
        setError(`We don't accept ${file.name.split(".").pop()?.toUpperCase() ?? "that"} files.`);
        continue;
      }

      setUploading((names) => [...names, file.name]);

      try {
        const added = await upload(file);
        if (added) {
          current = [...current, added];
          setFiles(current);
        }
      } finally {
        setUploading((names) => names.filter((name) => name !== file.name));
      }
    }
  }

  async function upload(file: File): Promise<StagedFile | null> {
    let sha256: string;
    try {
      sha256 = await hashFile(file);
    } catch {
      setError(`We couldn't read ${file.name}.`);
      return null;
    }

    const supabase = createClient();
    const storageKey = `${DELIVERY_PREFIX}/${workerId}/${jobId}/${objectName(file.name)}`;

    const { error: uploadError } = await supabase.storage
      .from(DELIVERY_BUCKET)
      .upload(storageKey, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      console.error("[deliveries] upload failed", uploadError);
      setError(`${file.name} didn't upload. Try again.`);
      return null;
    }

    const result = await registerDeliveryFile({
      jobId,
      storageKey,
      originalName: file.name,
      sha256,
    });

    if (!result.ok) {
      setError(result.error);
      return null;
    }

    return result.file;
  }

  async function remove(fileId: string) {
    setBusyFileId(fileId);
    setError(null);

    const result = await removeDeliveryFile(jobId, fileId);
    setBusyFileId(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setFiles((current) => current.filter((file) => file.fileId !== fileId));
  }

  async function open(fileId: string) {
    setBusyFileId(fileId);
    const result = await openStagedFile(jobId, fileId);
    setBusyFileId(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.kind === "url") window.open(result.url, "_blank", "noopener,noreferrer");
  }

  async function send() {
    setSending(true);
    setError(null);
    setNoteError(null);

    const result = await submitDelivery({
      jobId,
      note,
      fileIds: files.map((file) => file.fileId),
    });

    if (!result.ok) {
      setNoteError(result.fieldErrors?.note ?? null);
      setError(result.fieldErrors?.note ? null : result.error);
      setSending(false);
      setConfirming(false);
      return;
    }

    // On success the action revalidates and this whole panel is replaced by the
    // delivered state, so `sending` is deliberately left true.
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {attempt === 1 ? "Send your work" : `Send attempt ${attempt}`}
        </p>
        <p className="text-muted text-xs">
          Everything goes through Zevi — never over chat or a link. Up to{" "}
          {MAX_FILES_PER_DELIVERY} files, {formatBytes(maxUploadBytes)} each.
        </p>
      </div>

      {files.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-lg border">
          {files.map((file) => (
            <li key={file.fileId} className="space-y-1 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => void open(file.fileId)}
                  disabled={busyFileId === file.fileId}
                  className="hover:text-accent min-w-0 flex-1 truncate text-left text-sm underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {file.name}
                </button>

                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-muted text-xs tabular-nums">
                    {formatBytes(file.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove(file.fileId)}
                    disabled={busyFileId === file.fileId || sending}
                    className="text-muted hover:text-danger text-xs disabled:opacity-50"
                  >
                    Remove
                  </button>
                </span>
              </div>

              <p className="text-muted text-xs">{describeVisibility(file)}</p>
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

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ALLOWED_DELIVERY_MIME_TYPES.join(",")}
        className="sr-only"
        disabled={full || sending}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          void addFiles(picked);
        }}
      />

      <Button
        variant="secondary"
        onClick={() => inputRef.current?.click()}
        disabled={full || sending || uploading.length > 0}
        fullWidth={false}
      >
        {full ? `${MAX_FILES_PER_DELIVERY} files attached` : "Add files"}
      </Button>

      {nothingViewable ? (
        <Alert>
          Your client can&apos;t see any of this before they accept it. Add a PDF or an
          image export next to your source files and they can judge the work — otherwise
          they&apos;re deciding blind.
        </Alert>
      ) : null}

      <TextArea
        name="note"
        label="A note with it"
        hint="Optional. What you changed, what needs a look, anything they should know."
        rows={4}
        value={note}
        maxLength={DELIVERY_NOTE_MAX_LENGTH}
        error={noteError ?? undefined}
        onChange={(event) => setNote(event.target.value)}
        footer={`${note.length}/${DELIVERY_NOTE_MAX_LENGTH}`}
        disabled={sending}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {confirming ? (
        <div className="border-border space-y-3 rounded-lg border p-3">
          <p className="text-sm">
            Sending {files.length === 1 ? "this file" : `these ${files.length} files`} starts
            your client&apos;s {autoAcceptWindow} to review. If they say nothing, it&apos;s
            accepted automatically and the money is released to you.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void send()} disabled={sending} fullWidth={false}>
              {sending ? "Sending…" : "Send it"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={sending}
              fullWidth={false}
            >
              Not yet
            </Button>
          </div>
        </div>
      ) : (
        <Button
          onClick={() => setConfirming(true)}
          disabled={files.length === 0 || uploading.length > 0 || sending}
          fullWidth={false}
        >
          Deliver
        </Button>
      )}

      <p className="text-muted text-xs">
        Keep your own copy — delivered files are removed from Zevi seven days after
        the job is accepted.
      </p>
    </div>
  );
}

/** What the client will and will not be able to see, per file, before deciding. */
function describeVisibility(file: StagedFile): string {
  if (file.hasPreview) return "Your client will see a watermarked preview of this.";

  switch (previewKindFor(file.mimeType)) {
    case "text":
      return "Your client will be able to read this, but not download it.";
    case "image":
    case "pdf":
      // Registered as watermarkable but no derivative came back — too big, or
      // the file did not decode.
      return "We couldn't watermark this one, so it stays sealed until they accept.";
    default:
      return "Your client can't see this until they accept.";
  }
}
