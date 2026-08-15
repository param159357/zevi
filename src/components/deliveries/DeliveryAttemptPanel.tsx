import { DeliveryFiles } from "@/components/deliveries/DeliveryFiles";
import type { DeliveryAttempt, DeliveryStatus } from "@/lib/deliveries/types";
import { formatCount, formatDate, formatTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * One attempt, as both sides see it. A Server Component — only the file list
 * inside it needs the browser.
 *
 * Every attempt stays on the page, superseded ones included. Spec §11 leans on
 * "what did the worker actually send, and when" for every dispute it describes,
 * and a screen that shows only the newest version is a screen that has quietly
 * thrown that away.
 */

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending_review: "Waiting on the client",
  accepted: "Accepted",
  revision_requested: "Revision asked for",
  disputed: "In dispute",
  superseded: "Replaced by a later attempt",
};

const STATUS_TONES: Partial<Record<DeliveryStatus, string>> = {
  pending_review: "text-accent",
  accepted: "text-success",
  disputed: "text-danger",
  superseded: "text-muted",
};

export function DeliveryAttemptPanel({
  delivery,
  viewer,
  dimmed = false,
}: {
  delivery: DeliveryAttempt;
  viewer: "client" | "worker";
  /** Superseded attempts sit quieter than the one being decided on. */
  dimmed?: boolean;
}) {
  return (
    <section
      className={cn(
        "border-border space-y-3 rounded-xl border p-4",
        dimmed && "bg-surface-muted/40",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium">
          {delivery.attempt === 1 ? "First delivery" : `Attempt ${delivery.attempt}`}
          <span className="text-muted font-normal">
            {" · "}
            {formatDate(delivery.deliveredAt)} at {formatTime(delivery.deliveredAt)}
          </span>
        </h3>

        <span className={cn("text-xs", STATUS_TONES[delivery.status] ?? "text-foreground")}>
          {delivery.status === "accepted" && delivery.autoAccepted
            ? "Accepted automatically"
            : STATUS_LABELS[delivery.status]}
        </span>
      </div>

      {delivery.note ? (
        // Stored as typed. `whitespace-pre-wrap` keeps the worker's paragraphs
        // without ever treating their text as markup.
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{delivery.note}</p>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-muted text-xs">{formatCount(delivery.files.length, "file")}</p>
        <DeliveryFiles deliveryId={delivery.id} files={delivery.files} viewer={viewer} />
      </div>
    </section>
  );
}
