"use client";

import { useState } from "react";

import { describeLocked } from "@/lib/deliveries/access";
import { openDeliveredFile } from "@/lib/deliveries/actions";
import type { DeliveredFile, DeliveryAccess } from "@/lib/deliveries/types";
import { formatBytes } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * The files on one delivery, and how far the person looking may see them.
 *
 * The same list serves both sides, because both sides need the same fact and
 * neither needs it phrased the same way:
 *
 *   the client   sees what they are allowed to see, and a locked row says why
 *   the worker   always opens their own file, and reads underneath it what the
 *                client can see — which is the thing that decides whether the
 *                brief can be judged before acceptance
 *
 * `access` is computed server-side by `deliveryFileAccess()`. Nothing here
 * decides it, and the URL the action hands back is minted after that decision,
 * for the key that decision names.
 */

const CLIENT_ACTION: Record<DeliveryAccess, string> = {
  clean: "Download",
  preview: "Open preview",
  text: "View",
  locked: "Sealed",
};

const CLIENT_NOTE: Record<DeliveryAccess, string> = {
  clean: "Yours to keep",
  preview: "Watermarked until you accept",
  text: "View only until you accept",
  locked: "Sealed until you accept",
};

const WORKER_NOTE: Record<DeliveryAccess, string> = {
  clean: "Your client has the clean file",
  preview: "Your client sees a watermarked preview",
  text: "Your client can read it, not download it",
  locked: "Your client can't see this until they accept",
};

export function DeliveryFiles({
  deliveryId,
  files,
  viewer,
}: {
  deliveryId: string;
  files: DeliveredFile[];
  viewer: "client" | "worker";
}) {
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Text bodies are shown in place rather than in a new tab: there is no URL to
  // open, which is the whole point of that branch.
  const [reading, setReading] = useState<{ fileId: string; body: string; truncated: boolean } | null>(
    null,
  );

  async function open(file: DeliveredFile) {
    setBusyFileId(file.fileId);
    setError(null);

    const result = await openDeliveredFile(deliveryId, file.fileId);
    setBusyFileId(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    if (result.kind === "text") {
      setReading({ fileId: file.fileId, body: result.body, truncated: result.truncated });
      return;
    }

    setReading(null);
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  if (files.length === 0) {
    return <p className="text-muted text-xs">No files on this one.</p>;
  }

  return (
    <div className="space-y-2">
      <ul className="border-border divide-border divide-y rounded-lg border">
        {files.map((file) => {
          const sealed = viewer === "client" && file.access === "locked";
          const busy = busyFileId === file.fileId;

          return (
            <li key={file.fileId} className="space-y-1 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate text-sm">{file.name}</p>
                  <p className="text-muted text-xs">
                    {formatBytes(file.sizeBytes)} ·{" "}
                    {viewer === "worker" ? WORKER_NOTE[file.access] : CLIENT_NOTE[file.access]}
                  </p>
                </div>

                {sealed ? (
                  <span className="text-muted shrink-0 text-xs">Sealed</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void open(file)}
                    disabled={busy}
                    className={cn(
                      "hover:text-accent shrink-0 text-xs underline underline-offset-4",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    {busy
                      ? "Opening…"
                      : viewer === "worker"
                        ? "Open"
                        : CLIENT_ACTION[file.access]}
                  </button>
                )}
              </div>

              {sealed ? (
                <p className="text-muted text-xs">{describeLocked(file.mimeType)}</p>
              ) : null}

              {reading?.fileId === file.fileId ? (
                <div className="space-y-1">
                  {/* Selectable, not downloadable — spec §6. `whitespace-pre`
                      keeps the file's own shape without treating it as markup. */}
                  <pre className="border-border bg-surface-muted max-h-96 overflow-auto rounded-lg border p-3 text-xs whitespace-pre">
                    {reading.body}
                  </pre>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted text-xs">
                      {reading.truncated ? "Showing the start of the file." : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => setReading(null)}
                      className="text-muted hover:text-foreground text-xs underline underline-offset-4"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
