"use client";

import { useEffect, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { TextField } from "@/components/ui/TextField";
import {
  NOTICED_MAX_LENGTH,
  OPT_IN_TOTAL_MAX_LENGTH,
  SOFTWARE_MAX_LENGTH,
  TURNAROUND_MAX_LENGTH,
} from "@/lib/constants/matching";
import { optIntoJob } from "@/lib/matching/actions";
import type { FieldErrors, OptInFormValues } from "@/lib/matching/types";
import { optInLength } from "@/lib/matching/validation";

const EMPTY: OptInFormValues = { software: "", turnaround: "", noticed: "" };

/** Whole seconds still to wait, from the moment the server rendered the brief. */
function remainingSeconds(briefOpenedAt: string, dwellSeconds: number): number {
  const opened = Date.parse(briefOpenedAt);
  if (Number.isNaN(opened)) return dwellSeconds;

  return Math.max(0, Math.ceil(dwellSeconds - (Date.now() - opened) / 1_000));
}

/**
 * Spec §6: one tap, then three short fields totalling 300 characters, and a
 * 20-second dwell timer before the button activates.
 *
 * The tap and the timer do different jobs. The tap keeps the brief page from
 * opening as a form — a worker reads first. The timer is what a reflex click
 * runs into: it is measured from when the *server* rendered this brief, so
 * filling the fields at a human speed spends it without ever seeing it.
 *
 * Everything the button decides is decided again in `optIntoJob()`, and again
 * by a CHECK. Disabling it is a courtesy, not the rule.
 */
export function OptInForm({
  jobId,
  briefOpenedAt,
  dwellSeconds,
}: {
  jobId: string;
  briefOpenedAt: string;
  dwellSeconds: number;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<OptInFormValues>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Starts at the full wait so the server and the first client render agree;
  // the effect corrects it on mount, before anyone can have read the brief.
  const [remaining, setRemaining] = useState(dwellSeconds);

  useEffect(() => {
    setRemaining(remainingSeconds(briefOpenedAt, dwellSeconds));

    const id = setInterval(() => {
      const left = remainingSeconds(briefOpenedAt, dwellSeconds);
      setRemaining(left);
      if (left <= 0) clearInterval(id);
    }, 250);

    return () => clearInterval(id);
  }, [briefOpenedAt, dwellSeconds]);

  const used = optInLength(values);
  const over = used > OPT_IN_TOTAL_MAX_LENGTH;
  const waiting = remaining > 0;

  function update(field: keyof OptInFormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const { [field]: _removed, ...rest } = current;
      return rest;
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const result = await optIntoJob({ jobId, briefOpenedAt, ...values });

    // On success the action revalidates and this panel is replaced by the
    // "you've opted in" state, so there is nothing to reset — leaving `busy`
    // set keeps the button from flickering back to life in between.
    if (!result.ok) {
      if (result.fieldErrors) setFieldErrors(result.fieldErrors);
      setError(result.error ?? null);
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <p className="text-muted min-w-0 flex-1 text-sm">
          Three short questions, {OPT_IN_TOTAL_MAX_LENGTH} characters across all of them.
        </p>
        <Button onClick={() => setOpen(true)}>I&apos;m interested</Button>
      </div>
    );
  }

  return (
    <div className="border-border space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Tell the client three things</h2>
        <p className="text-muted text-xs">
          They read these side by side with everyone else&apos;s. Short and specific beats
          long.
        </p>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <TextField
        name="software"
        label="What software will you use?"
        value={values.software}
        onChange={(event) => update("software", event.target.value)}
        error={fieldErrors.software}
        maxLength={SOFTWARE_MAX_LENGTH}
        autoComplete="off"
        placeholder="Figma, then After Effects for the animation"
      />

      <TextField
        name="turnaround"
        label="What's your turnaround?"
        value={values.turnaround}
        onChange={(event) => update("turnaround", event.target.value)}
        error={fieldErrors.turnaround}
        maxLength={TURNAROUND_MAX_LENGTH}
        autoComplete="off"
        placeholder="First draft in two days, final by Friday"
      />

      <TextArea
        name="noticed"
        label="One thing you noticed in this brief"
        hint="Something only someone who read it would say. This is the one they'll remember."
        rows={3}
        value={values.noticed}
        onChange={(event) => update("noticed", event.target.value)}
        error={fieldErrors.noticed}
        maxLength={NOTICED_MAX_LENGTH}
        footer={
          <span className={over ? "text-danger" : undefined}>
            {used} / {OPT_IN_TOTAL_MAX_LENGTH} used
          </span>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted min-w-0 flex-1 text-xs" aria-live="polite">
          {waiting
            ? `Take a moment with the brief — ${remaining}s.`
            : "You can withdraw until a client shortlists you."}
        </p>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || waiting || over}>
            {busy ? "Sending…" : waiting ? `Opt in in ${remaining}s` : "Opt in"}
          </Button>
        </div>
      </div>
    </div>
  );
}
