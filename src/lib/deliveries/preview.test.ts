import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { PREVIEW_MAX_EDGE, PREVIEW_MAX_SOURCE_BYTES } from "@/lib/constants/deliveries";
import { generatePreview, watermarkLabel } from "@/lib/deliveries/preview";

/**
 * The one part of the delivery flow that is worth a unit test: everything else
 * is a row lock or a policy, and a mock of Postgres would only test the mock.
 *
 * What matters here is that the derivative is genuinely a *different* file. A
 * preview that came back byte-identical to its source would mean the client is
 * being handed the clean work while the escrow still holds the money for it —
 * which is the exact failure this whole module exists to prevent, and the kind
 * that is invisible on screen because the image still looks right.
 */

async function redPng(width = 900, height = 700): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer(),
  );
}

async function twoPagePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const _page of [0, 1]) {
    const page = document.addPage([595, 842]);
    page.drawText("The delivered work", { x: 60, y: 700, size: 24, font });
  }

  return document.save();
}

const LABEL = watermarkLabel("57847003-1364-4e03-a7e4-82566790216f");

describe("watermarkLabel", () => {
  it("carries a traceable slice of the job id", () => {
    expect(LABEL).toBe("ZEVI PREVIEW · 57847003");
  });
});

describe("generatePreview — raster", () => {
  it("returns a JPEG that is not the source", async () => {
    const source = await redPng();
    const result = await generatePreview({ bytes: source, mimeType: "image/png", label: LABEL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.extension).toBe("jpg");
    // FF D8 FF — a JPEG, so the PNG source cannot have been passed through.
    expect(Array.from(result.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });

  it("paints the mark into the pixels rather than beside them", async () => {
    const source = await redPng();
    const result = await generatePreview({ bytes: source, mimeType: "image/png", label: LABEL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A flat red field has one colour. Compositing text over it introduces
    // others, and there is no way back to the flat original from this.
    const { channels } = await sharp(result.bytes).stats();
    expect(channels[0].stdev).toBeGreaterThan(0);
  });

  it("downscales anything past the long edge", async () => {
    const source = await redPng(3200, 2400);
    const result = await generatePreview({ bytes: source, mimeType: "image/png", label: LABEL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(PREVIEW_MAX_EDGE);
    expect(meta.height).toBe(1200);
  });
});

describe("generatePreview — PDF", () => {
  it("stamps every page and keeps it a PDF", async () => {
    const source = await twoPagePdf();
    const result = await generatePreview({
      bytes: source,
      mimeType: "application/pdf",
      label: LABEL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mimeType).toBe("application/pdf");
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");

    const marked = await PDFDocument.load(result.bytes);
    expect(marked.getPageCount()).toBe(2);
    // Stamping adds content to both pages, so the file cannot come back the
    // same size it went in.
    expect(result.bytes.byteLength).toBeGreaterThan(source.byteLength);
  });
});

describe("generatePreview — what it refuses", () => {
  it("skips a type it cannot mark rather than passing the source through", async () => {
    const result = await generatePreview({
      bytes: new Uint8Array([0, 1, 2, 3]),
      mimeType: "video/mp4",
      label: LABEL,
    });

    expect(result).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("skips anything too big to pull through a Server Action", async () => {
    const result = await generatePreview({
      bytes: new Uint8Array(PREVIEW_MAX_SOURCE_BYTES + 1),
      mimeType: "image/png",
      label: LABEL,
    });

    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("reports a failure instead of throwing when the bytes are not what they claim", async () => {
    const result = await generatePreview({
      bytes: new TextEncoder().encode("this is not a pdf"),
      mimeType: "application/pdf",
      label: LABEL,
    });

    expect(result).toEqual({ ok: false, reason: "failed" });
  });
});
