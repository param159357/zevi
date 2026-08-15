/**
 * Watermarked previews — spec §6: "visual work: watermarked preview visible,
 * clean file unlocks on acceptance".
 *
 * Server-only. Never import this into a Client Component.
 *
 * The preview is a *separate object*, generated once when the worker registers
 * the file and stored under `delivery-previews/`, which no storage policy
 * grants anyone. The original is never handed to the client before
 * `delivery_files.unlocked_at` is written — there is no code path where the
 * browser receives the clean bytes and the watermark is applied on top, because
 * that is not a watermark, it is a caption over a file the client already has.
 *
 * ### What this can and cannot watermark, honestly
 *
 *   raster images   sharp: downscaled to `PREVIEW_MAX_EDGE`, tiled diagonal
 *                   text composited into the pixels. There is no clean copy in
 *                   the derivative to recover.
 *   PDF             pdf-lib: the same text stamped on every page. This one is
 *                   weaker and worth saying so — the mark is an overlay in the
 *                   page's content stream, so someone determined can strip it
 *                   and get the vectors underneath. It is a deterrent and a
 *                   traceable one (the job id is in the mark), not a lock. The
 *                   alternative is rasterising every page, which needs a PDF
 *                   renderer this stack does not have.
 *   everything else no preview at all. See `previewKindFor`.
 *
 * A failure here is never fatal: `generatePreview` returns a reason instead of
 * throwing, and a file with no preview is shown to the client as locked. The
 * safe direction for a bug is "the client sees less", never "the client sees
 * the clean file".
 */

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import sharp from "sharp";

import {
  PREVIEW_MAX_EDGE,
  PREVIEW_MAX_SOURCE_BYTES,
  previewKindFor,
} from "@/lib/constants/deliveries";

export type PreviewSkipReason = "unsupported_type" | "too_large" | "failed";

export type PreviewResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; mimeType: string; extension: string }
  | { ok: false; reason: PreviewSkipReason };

/**
 * sharp returns a Node `Buffer` and pdf-lib a bare `Uint8Array`, both of which
 * TypeScript types over `ArrayBufferLike` — which `Blob` will not take, because
 * it could be a `SharedArrayBuffer`. One copy into a view TypeScript can see the
 * backing store of is the price of not writing an assertion here.
 */
function ownBuffer(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

/**
 * The mark itself. The job id is in it on purpose: a preview that turns up
 * somewhere it should not says which job it came from (spec §10 — sample theft
 * and disintermediation are both "we can prove it" problems).
 */
export function watermarkLabel(jobId: string): string {
  return `ZEVI PREVIEW · ${jobId.slice(0, 8)}`;
}

/** SVG is markup; a file name or an id interpolated into it is not. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A tiled, rotated wall of text sized to the image it will sit on.
 *
 * Explicit `<text>` elements rather than an SVG `<pattern>`: sharp renders SVG
 * through libvips' rasteriser, and a plain list of elements is the subset every
 * version of it agrees on.
 */
function watermarkSvg(width: number, height: number, label: string): Buffer {
  const step = Math.max(120, Math.round(Math.min(width, height) / 3));
  const fontSize = Math.max(13, Math.round(step / 9));
  const text = escapeXml(label);
  const marks: string[] = [];

  // Drawn over twice the frame in both directions so the -30° rotation still
  // covers the corners.
  for (let y = -height; y < height * 2; y += step) {
    for (let x = -width; x < width * 2; x += Math.round(step * 1.8)) {
      marks.push(
        `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" ` +
          `font-size="${fontSize}" font-weight="bold" letter-spacing="1" ` +
          `fill="#ffffff" fill-opacity="0.5" stroke="#000000" stroke-opacity="0.16" ` +
          `stroke-width="0.7">${text}</text>`,
      );
    }
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<g transform="rotate(-30 ${Math.round(width / 2)} ${Math.round(height / 2)})">` +
      marks.join("") +
      `</g></svg>`,
  );
}

async function previewImage(source: Uint8Array, label: string): Promise<PreviewResult> {
  // `failOn: "none"` keeps a slightly malformed but readable file from throwing;
  // sharp's default pixel ceiling still applies, which is what stops a small
  // file that decodes to a gigapixel bomb.
  const downscaled = await sharp(source, { failOn: "none" })
    .rotate()
    .resize({
      width: PREVIEW_MAX_EDGE,
      height: PREVIEW_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    // Transparency would let the mark disappear against whatever the viewer
    // puts behind it, and JPEG has no alpha to preserve anyway.
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 78 })
    .toBuffer({ resolveWithObject: true });

  const { width, height } = downscaled.info;

  const marked = await sharp(downscaled.data)
    .composite([{ input: watermarkSvg(width, height, label) }])
    .jpeg({ quality: 78 })
    .toBuffer();

  return { ok: true, bytes: ownBuffer(marked), mimeType: "image/jpeg", extension: "jpg" };
}

async function previewPdf(source: Uint8Array, label: string): Promise<PreviewResult> {
  // An encrypted PDF throws here rather than being stamped, which is the right
  // answer: we cannot mark it, so it stays locked.
  const document = await PDFDocument.load(source, { updateMetadata: false });
  const font = await document.embedFont(StandardFonts.HelveticaBold);

  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(12, Math.round(Math.min(width, height) / 22));
    const step = Math.max(120, Math.round(Math.min(width, height) / 3));
    const textWidth = font.widthOfTextAtSize(label, size);

    for (let y = -height; y < height * 2; y += step) {
      for (let x = -width; x < width * 2; x += Math.round(textWidth * 1.5)) {
        page.drawText(label, {
          x,
          y,
          size,
          font,
          color: rgb(0.42, 0.42, 0.42),
          opacity: 0.28,
          rotate: degrees(30),
        });
      }
    }
  }

  return {
    ok: true,
    bytes: ownBuffer(await document.save({ useObjectStreams: false })),
    mimeType: "application/pdf",
    extension: "pdf",
  };
}

/**
 * The one entry point. Returns a reason rather than throwing, because a file we
 * cannot mark is a normal outcome — a video, a PPTX, a 200MB archive — and the
 * caller's answer to all of them is the same: register the file and leave it
 * locked.
 */
export async function generatePreview({
  bytes,
  mimeType,
  label,
}: {
  bytes: Uint8Array;
  mimeType: string;
  label: string;
}): Promise<PreviewResult> {
  if (bytes.byteLength > PREVIEW_MAX_SOURCE_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  const kind = previewKindFor(mimeType);

  if (kind !== "image" && kind !== "pdf") {
    return { ok: false, reason: "unsupported_type" };
  }

  try {
    return kind === "image" ? await previewImage(bytes, label) : await previewPdf(bytes, label);
  } catch (error) {
    // Worth the log — a format we thought we could mark and could not is how
    // the list in `constants/deliveries.ts` gets corrected — but not worth
    // failing the worker's upload over.
    console.error(`[deliveries] could not watermark a ${mimeType}:`, error);
    return { ok: false, reason: "failed" };
  }
}
