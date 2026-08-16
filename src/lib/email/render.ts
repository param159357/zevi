/**
 * One document, two bodies.
 *
 * Pure — no I/O, no clock, no environment. Which is what lets `templates.test.ts`
 * assert on the exact bytes a recipient receives.
 *
 * ### Why the HTML looks like 2005
 *
 * Because Outlook renders with Word and Gmail strips `<style>`. A table with
 * inlined attributes is not nostalgia, it is the intersection of what the mail
 * clients actually implement. The rules this file follows:
 *
 *   * every colour, font and spacing value inlined on the element — no
 *     stylesheet, no classes, no `<style>` block to be stripped
 *   * tables for layout, `border="0" cellpadding="0" cellspacing="0"`
 *   * no images, so nothing breaks when a client blocks them and nothing is
 *     needed to make the message legible. It also means no tracking pixel, which
 *     is a decision worth making on purpose: these are receipts and deadlines,
 *     not marketing, and there is nothing to learn from an open rate that would
 *     change what we send
 *   * no web fonts, no media queries beyond a fluid 600px table
 *
 * ### Escaping
 *
 * Everything interpolated is escaped, and the escaping is here rather than at
 * each call site so a template author cannot forget. Job titles, worker names
 * and revision reasons are all user-written: a client who names a job
 * `</td><script>` is a client whose email must still render as that literal
 * text. `escapeHtml` covers the five characters that matter in element and
 * attribute content, and URLs go through `safeUrl`, which refuses any scheme
 * that is not http(s) — a `javascript:` action is a phishing link we sent
 * ourselves.
 */

import { EMAIL_COLORS, EMAIL_WIDTH_PX, SUPPORT_EMAIL } from "@/lib/constants/email";
import type { EmailBlock, EmailDocument } from "@/lib/email/document";

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * An href we are willing to put our name on, or `#` — which renders as a dead
 * button rather than as a live link somewhere we did not intend.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "#";
    return escapeHtml(parsed.toString());
  } catch {
    return "#";
  }
}

function htmlBlock(block: EmailBlock): string {
  const paragraph = (content: string, extra = "") =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${EMAIL_COLORS.foreground};${extra}">${content}</p>`;

  switch (block.kind) {
    case "paragraph":
      return paragraph(escapeHtml(block.text));

    case "note":
      return paragraph(
        escapeHtml(block.text),
        `font-size:13px;line-height:20px;color:${EMAIL_COLORS.muted};`,
      );

    case "quote":
      return (
        `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px;">` +
        `<tr><td style="padding:12px 16px;background:${EMAIL_COLORS.background};` +
        `border-left:3px solid ${EMAIL_COLORS.border};font-size:15px;line-height:24px;` +
        `color:${EMAIL_COLORS.foreground};">${escapeHtml(block.text)}</td></tr></table>`
      );

    case "facts": {
      const rows = block.rows
        .map(
          (row) =>
            `<tr>` +
            `<td style="padding:6px 0;font-size:14px;line-height:20px;color:${EMAIL_COLORS.muted};">${escapeHtml(row.label)}</td>` +
            `<td align="right" style="padding:6px 0;font-size:14px;line-height:20px;` +
            `color:${EMAIL_COLORS.foreground};${row.strong ? "font-weight:600;" : ""}">${escapeHtml(row.value)}</td>` +
            `</tr>`,
        )
        .join("");

      return (
        `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" ` +
        `style="margin:0 0 16px;border-top:1px solid ${EMAIL_COLORS.border};` +
        `border-bottom:1px solid ${EMAIL_COLORS.border};">${rows}</table>`
      );
    }
  }
}

function textBlock(block: EmailBlock): string {
  switch (block.kind) {
    case "paragraph":
    case "note":
      return block.text;
    case "quote":
      // The one place indentation carries meaning in a plain-text body.
      return block.text
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
    case "facts":
      return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
  }
}

/**
 * Render both bodies.
 *
 * `Zevi` in the header is text, not a logo: an image-blocked email should still
 * say who it is from. The footer says why the message arrived and where to
 * reply, which is both a deliverability signal and the honest answer to
 * "who is emailing me about a job ID".
 */
export function renderEmail(doc: EmailDocument): RenderedEmail {
  const body = doc.blocks.map(htmlBlock).join("");

  const action = doc.action
    ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;">` +
      `<tr><td align="center" bgcolor="${EMAIL_COLORS.primary}" style="border-radius:6px;">` +
      `<a href="${safeUrl(doc.action.url)}" ` +
      `style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:15px;` +
      `font-weight:600;line-height:20px;color:${EMAIL_COLORS.primaryForeground};text-decoration:none;">` +
      `${escapeHtml(doc.action.label)}</a></td></tr></table>`
    : "";

  const footnote = doc.footnote
    ? `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${EMAIL_COLORS.muted};">` +
      `${escapeHtml(doc.footnote)}</p>`
    : "";

  const html =
    `<!doctype html>` +
    `<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light">` +
    `<title>${escapeHtml(doc.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${EMAIL_COLORS.background};">` +
    // Hidden, and padded so a client that shows the next few characters of the
    // body shows nothing rather than the start of the markup.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">` +
    `${escapeHtml(doc.preheader)}${"&#8199;&#65279;".repeat(60)}</div>` +
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" ` +
    `style="background:${EMAIL_COLORS.background};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="${EMAIL_WIDTH_PX}" ` +
    `style="max-width:${EMAIL_WIDTH_PX}px;width:100%;background:${EMAIL_COLORS.surface};` +
    `border:1px solid ${EMAIL_COLORS.border};border-radius:8px;font-family:${FONT_STACK};">` +
    `<tr><td style="padding:24px 28px 0;">` +
    `<p style="margin:0 0 20px;font-size:15px;font-weight:700;letter-spacing:-0.01em;` +
    `color:${EMAIL_COLORS.foreground};">Zevi</p>` +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;` +
    `color:${EMAIL_COLORS.foreground};">${escapeHtml(doc.heading)}</h1>` +
    `</td></tr>` +
    `<tr><td style="padding:0 28px 8px;">${body}${action}${footnote}</td></tr>` +
    `<tr><td style="padding:16px 28px 24px;border-top:1px solid ${EMAIL_COLORS.border};">` +
    `<p style="margin:0;font-size:12px;line-height:18px;color:${EMAIL_COLORS.muted};">` +
    `You're receiving this because you have a Zevi account. ` +
    `Questions about this email? Write to ` +
    `<a href="mailto:${SUPPORT_EMAIL}" style="color:${EMAIL_COLORS.muted};">${SUPPORT_EMAIL}</a>.` +
    `</p></td></tr></table></td></tr></table></body></html>`;

  const text = [
    doc.heading,
    "",
    ...doc.blocks.flatMap((block) => [textBlock(block), ""]),
    ...(doc.action ? [`${doc.action.label}: ${doc.action.url}`, ""] : []),
    ...(doc.footnote ? [doc.footnote, ""] : []),
    "—",
    `You're receiving this because you have a Zevi account. Questions? ${SUPPORT_EMAIL}`,
  ].join("\n");

  return { subject: doc.subject, html, text };
}
