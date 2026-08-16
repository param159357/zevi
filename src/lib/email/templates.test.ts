import { describe, expect, it } from "vitest";

import { renderEmail, safeUrl } from "@/lib/email/render";
import { EMAIL_SAMPLES } from "@/lib/email/samples";
import { EmailPayloadError, parsePayload } from "@/lib/email/template";
import { EMAIL_TEMPLATES, buildDocument, renderTemplate } from "@/lib/email/templates";

/**
 * SPEC §15, checked against every template rather than against a chosen one.
 *
 *   Plain, short, one action each, job ID in every subject line.
 *
 * Those four are the whole specification of an essential email, and three of
 * them are testable — the fourth, whether it reads well, is what `/dev/emails`
 * is for. The loop below is deliberately over the registry rather than over a
 * list written here: a template added without a sample, or with a subject that
 * forgets the job reference, fails without anybody remembering to add a case.
 */

const templateIds = Object.keys(EMAIL_TEMPLATES) as Array<keyof typeof EMAIL_TEMPLATES>;

describe("the registry", () => {
  it("files every template under its own id", () => {
    for (const [key, template] of Object.entries(EMAIL_TEMPLATES)) {
      expect(template.id).toBe(key);
    }
  });

  it("has a sample payload for every template", () => {
    expect(Object.keys(EMAIL_SAMPLES).sort()).toEqual(templateIds.slice().sort());
  });

  it("covers spec §15's essential events", () => {
    // Fifteen bullets, thirteen templates: `verify email` is Supabase Auth's
    // message and `worker assigned` is the same instant as `payment received`.
    // Both are argued in `templates/client.ts`; this is the count in one place
    // so a future addition is a deliberate change to a number.
    expect(templateIds).toHaveLength(13);
  });
});

describe.each(templateIds)("%s", (id) => {
  const payload = EMAIL_SAMPLES[id];
  const doc = buildDocument(id, payload);
  const rendered = renderTemplate(id, payload);

  it("renders both a text and an HTML body", () => {
    expect(rendered.text.trim().length).toBeGreaterThan(0);
    expect(rendered.html.startsWith("<!doctype html>")).toBe(true);
    // A text part is not a courtesy — a message without one scores worse with
    // every spam filter that looks, which is what spec §15 is warning about.
    expect(rendered.text).not.toMatch(/<[a-z]/i);
  });

  it("says something and asks for one thing", () => {
    expect(doc.heading.length).toBeGreaterThan(0);
    expect(doc.preheader.length).toBeGreaterThan(0);

    // `action` is a single optional field rather than a list, so "one action
    // each" cannot be violated in the document. What this checks is the
    // rendering: exactly one clickable link in the body, plus the footer's
    // mailto, and no template smuggling a second URL into a paragraph.
    const links = rendered.html.match(/<a href="http/g) ?? [];
    expect(links).toHaveLength(doc.action ? 1 : 0);
  });

  it("links somewhere absolute, or nowhere", () => {
    if (!doc.action) return;
    expect(doc.action.url).toMatch(/^https?:\/\//);
    // Never `#`, which is what `safeUrl` renders when it will not vouch for a
    // link — a dead button in a real email.
    expect(rendered.html).toContain(`<a href="${doc.action.url}"`);
  });

  it("carries the job reference in the subject when it is about a job", () => {
    const jobRef = (payload as { jobRef?: string | null }).jobRef;
    if (!jobRef) return;

    expect(rendered.subject).toContain(jobRef);
  });

  it("keeps the subject short enough to survive a mobile inbox", () => {
    // Gmail on a phone shows roughly this much. Not a rule from the spec — a
    // rule from the medium, and the reason subjects lead with the event rather
    // than with `Job 57847003 —`.
    expect(rendered.subject.length).toBeLessThanOrEqual(78);
  });
});

describe("escaping", () => {
  const hostile = {
    ...EMAIL_SAMPLES.payment_received,
    jobTitle: '</td><script>alert("xss")</script> & "quotes" & <b>bold</b>',
    workerName: "O'Brien & Sons",
  };

  const rendered = renderTemplate("payment_received", hostile);

  it("renders a hostile job title as literal text", () => {
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("&amp; &quot;quotes&quot;");
  });

  it("escapes the apostrophe in a name, once", () => {
    expect(rendered.html).toContain("O&#39;Brien &amp; Sons");
    expect(rendered.html).not.toContain("&amp;amp;");
  });

  it("leaves the text body alone, because there is nothing to escape into", () => {
    expect(rendered.text).toContain('</td><script>alert("xss")</script>');
  });

  it("refuses a link scheme it will not vouch for", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("#");
    expect(safeUrl("not a url at all")).toBe("#");
    expect(safeUrl("https://zevi.in/review/57847003")).toBe("https://zevi.in/review/57847003");
  });
});

describe("money in an email", () => {
  it("shows every line separately and never folds them into a total", () => {
    const rendered = renderTemplate("payment_received", EMAIL_SAMPLES.payment_received);

    // Spec §8, and a tax requirement as much as a design one: budget,
    // commission and GST each stand on their own line beside the total.
    expect(rendered.text).toContain("Budget (held in escrow): ₹1,499.00");
    expect(rendered.text).toContain("Zevi commission: ₹80.70");
    expect(rendered.text).toContain("GST: ₹14.53");
    expect(rendered.text).toContain("Total charged: ₹1,594.23");
  });

  it("tells a worker what they receive, not what the job is worth", () => {
    const rendered = renderTemplate("worker_selected", EMAIL_SAMPLES.worker_selected);

    expect(rendered.text).toContain("You receive: ₹1,431.00");
    // And in the preheader, so it is visible in the inbox list without opening.
    expect(rendered.html).toContain("₹1,431.00 after commission");
  });
});

describe("the auto-accept reminder", () => {
  const rendered = renderTemplate("auto_accept_reminder", EMAIL_SAMPLES.auto_accept_reminder);

  it("says what silence costs, which is the only reason it is sent", () => {
    expect(rendered.text).toContain("accepted for you and the worker is paid");
    expect(rendered.subject).toContain("12 hours left");
  });
});

describe("the dispute update", () => {
  it("changes what it says with the stage, not which template it is", () => {
    const raised = renderTemplate("dispute_update", {
      ...EMAIL_SAMPLES.dispute_update,
      stage: "raised",
    });
    const resolved = renderTemplate("dispute_update", {
      ...EMAIL_SAMPLES.dispute_update,
      stage: "resolved",
      detail: null,
    });

    expect(raised.text).toContain("24 hours");
    expect(resolved.text).toContain("decided");
    expect(raised.text).not.toBe(resolved.text);
  });

  it("still renders a stage it has never heard of", () => {
    // A row queued by an older deploy is worth sending as "there's an update"
    // rather than failing in the drain.
    const unknown = renderTemplate("dispute_update", {
      ...EMAIL_SAMPLES.dispute_update,
      stage: "escalated_to_layer_4",
    });

    expect(unknown.text).toContain("update");
    expect(unknown.subject).toContain("57847003");
  });
});

describe("parsePayload — the stored payload, read back after a deploy", () => {
  const fields = { jobRef: "text", budgetPaise: "int", url: "url", note: "text?" } as const;

  it("accepts what it declared", () => {
    expect(
      parsePayload("t", fields, {
        jobRef: "57847003",
        budgetPaise: 149_900,
        url: "https://zevi.in/x",
        note: null,
      }),
    ).toEqual({ jobRef: "57847003", budgetPaise: 149_900, url: "https://zevi.in/x", note: null });
  });

  it("refuses a missing field rather than rendering an empty sentence", () => {
    expect(() => parsePayload("t", fields, { budgetPaise: 1, url: "https://zevi.in/x" })).toThrow(
      EmailPayloadError,
    );
  });

  it("refuses money that is not a whole number of paise", () => {
    expect(() =>
      parsePayload("t", fields, { jobRef: "a", budgetPaise: 149.5, url: "https://zevi.in/x" }),
    ).toThrow(/whole number/);
  });

  it("refuses a number that arrived as a string", () => {
    expect(() =>
      parsePayload("t", fields, { jobRef: "a", budgetPaise: "149900", url: "https://zevi.in/x" }),
    ).toThrow(/whole number/);
  });

  it("refuses a link that is not http(s)", () => {
    expect(() =>
      parsePayload("t", fields, { jobRef: "a", budgetPaise: 1, url: "javascript:alert(1)" }),
    ).toThrow(/http/);
  });

  it("names the template and the field, because the row lands in a table", () => {
    expect(() => parsePayload("payment_received", fields, {})).toThrow(
      "email payload for payment_received: jobRef is missing",
    );
  });
});

describe("renderEmail", () => {
  it("hides the preheader from the body but keeps it in the source", () => {
    const rendered = renderEmail({
      subject: "s",
      preheader: "the line beside the subject",
      heading: "h",
      blocks: [{ kind: "paragraph", text: "body" }],
    });

    expect(rendered.html).toContain("the line beside the subject");
    expect(rendered.html).toContain("display:none");
    expect(rendered.text).not.toContain("the line beside the subject");
  });

  it("renders a facts block as label/value pairs in both bodies", () => {
    const rendered = renderEmail({
      subject: "s",
      preheader: "p",
      heading: "h",
      blocks: [{ kind: "facts", rows: [{ label: "Job", value: "57847003" }] }],
    });

    expect(rendered.text).toContain("Job: 57847003");
    expect(rendered.html).toContain("57847003");
  });
});
