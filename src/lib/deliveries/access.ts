/**
 * The one place that decides how far someone may see a delivered file.
 *
 * Pure, so the Server Action that mints a URL and the screen that renders a
 * label read the same answer from the same function. Importable from a Client
 * Component: it decides what is *shown*, and the signed URL is minted server-
 * side afterwards from the same call.
 *
 * The hinge is `delivery_files.unlocked_at`, exactly as migration 0008 said it
 * would be: before it, a watermarked preview or nothing; after it, the original.
 * Nothing else here can produce `clean`.
 *
 * Note the order. `unlocked` is checked first, then the preview, and the
 * fallthrough is `locked` — so a file whose watermarking failed, or which was
 * too big to watermark, is withheld rather than shown. Every way this function
 * can be wrong ends with the client seeing less than they might have, never
 * with them holding work the escrow is still paying for.
 */

import { PREVIEW_MAX_SOURCE_BYTES, previewKindFor } from "@/lib/constants/deliveries";
import type { DeliveryAccess } from "@/lib/deliveries/types";

export function deliveryFileAccess({
  unlocked,
  mimeType,
  sizeBytes,
  hasPreview,
}: {
  /** `delivery_files.unlocked_at` is set — the client accepted, or the clock did. */
  unlocked: boolean;
  mimeType: string;
  sizeBytes: number;
  /** `files.preview_key` is set — a watermarked derivative actually exists. */
  hasPreview: boolean;
}): DeliveryAccess {
  if (unlocked) return "clean";
  if (hasPreview) return "preview";

  // An image or a PDF that got this far has no derivative — watermarking failed
  // or the source was too big — so it is locked, not shown. Only text has no
  // generation step behind it, which is why its own size ceiling is checked
  // here rather than inherited from whether a preview exists.
  if (previewKindFor(mimeType) === "text" && sizeBytes <= PREVIEW_MAX_SOURCE_BYTES) {
    return "text";
  }

  return "locked";
}

/** Why a locked row is locked, in the client's words rather than ours. */
export function describeLocked(mimeType: string): string {
  if (mimeType.startsWith("video/")) {
    return "Video can't be watermarked here yet, so it stays sealed until you accept.";
  }
  if (mimeType.startsWith("audio/")) {
    return "Audio stays sealed until you accept.";
  }
  if (mimeType.startsWith("application/zip") || mimeType === "application/x-zip-compressed") {
    return "Archives stay sealed until you accept.";
  }
  return "We can't show a safe preview of this format, so it stays sealed until you accept.";
}
