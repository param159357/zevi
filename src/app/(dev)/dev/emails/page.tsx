import { EMAIL_SAMPLES } from "@/lib/email/samples";
import { EMAIL_TEMPLATES, buildDocument, renderTemplate } from "@/lib/email/templates";
import type { EmailTemplateId } from "@/lib/email/template";

/**
 * Every essential email, rendered, on one page.
 *
 * **Development only** — the `(dev)` layout 404s the whole subtree in
 * production, so this is not a route that exists on the live site. There is no
 * data on it either: everything comes from `lib/email/samples.ts`, the same
 * fixtures `templates.test.ts` asserts against, so nothing here reads a
 * database or needs a session.
 *
 * It exists because the four rules in spec §15 divide unevenly. "Job ID in
 * every subject line" and "one action each" are testable and tested; "plain"
 * and "short" are judgements, and the only way to make them is to look at the
 * thing. An email is also the one surface where the rendering is somebody
 * else's — an inline-styled table read by Gmail and by Outlook's Word engine —
 * so `srcDoc` here is the closest a browser gets to what will actually arrive.
 *
 *   npm run dev  →  http://localhost:3000/dev/emails
 */

export const dynamic = "force-static";

const ids = Object.keys(EMAIL_TEMPLATES) as EmailTemplateId[];

export default function EmailPreviewPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Essential emails</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Spec §15, rendered from the sample payloads in{" "}
        <code className="text-xs">lib/email/samples.ts</code>. Development only — this route 404s
        in production.
      </p>

      <nav className="mt-6 flex flex-wrap gap-2">
        {ids.map((id) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:text-foreground"
          >
            {id}
          </a>
        ))}
      </nav>

      <div className="mt-10 space-y-14">
        {ids.map((id) => {
          const doc = buildDocument(id, EMAIL_SAMPLES[id]);
          const rendered = renderTemplate(id, EMAIL_SAMPLES[id]);

          return (
            <section key={id} id={id} className="scroll-mt-8">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-mono text-sm font-semibold">{id}</h2>
                <span className="text-xs text-muted">
                  {EMAIL_TEMPLATES[id].audience} · {EMAIL_TEMPLATES[id].notification}
                </span>
              </header>

              <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Subject</dt>
                <dd className="font-medium">{rendered.subject}</dd>
                <dt className="text-muted">Preview</dt>
                <dd className="text-muted">{doc.preheader}</dd>
              </dl>

              {/* `srcDoc` rather than a div: the email's own inlined styles are
                  what a mail client sees, and rendering it inside this page's
                  stylesheet would flatter it. */}
              <iframe
                title={`${id} — HTML`}
                srcDoc={rendered.html}
                className="mt-4 h-[36rem] w-full rounded-lg border border-border bg-white"
              />

              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-muted">
                  Plain text — what a spam filter reads, and what an Apple Watch shows
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-muted p-4 text-xs leading-relaxed whitespace-pre-wrap">
                  {rendered.text}
                </pre>
              </details>
            </section>
          );
        })}
      </div>
    </main>
  );
}
