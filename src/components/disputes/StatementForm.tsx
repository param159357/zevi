"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { STATEMENT_MAX_LENGTH } from "@/lib/constants/disputes";
import { respondToDispute } from "@/lib/disputes/actions";

/**
 * The other side's 500 characters — spec §11's "other side has 24h to respond".
 *
 * No confirmation step, unlike raising one. The money is already frozen and the
 * case is already open; adding your side of it makes nothing worse and a
 * reviewer deciding without it is the thing to be afraid of here.
 */
export function StatementForm({
  disputeId,
  deadlineNote,
}: {
  disputeId: string;
  deadlineNote: string;
}) {
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setFieldError(null);

    const result = await respondToDispute({ disputeId, statement });

    if (!result.ok) {
      setFieldError(result.fieldErrors?.statement ?? null);
      setError(result.fieldErrors?.statement ? null : result.error);
      setBusy(false);
      return;
    }

    // On success the action revalidates and this form is replaced by the
    // statement it just filed, so `busy` is deliberately left true.
  }

  return (
    <div className="border-border space-y-3 rounded-xl border p-4">
      <TextArea
        name="statement"
        label="Your side of it"
        hint={`${deadlineNote} A decision is made from both statements, so this is your chance to be heard.`}
        rows={7}
        value={statement}
        maxLength={STATEMENT_MAX_LENGTH}
        error={fieldError ?? undefined}
        onChange={(event) => setStatement(event.target.value)}
        footer={`${statement.length}/${STATEMENT_MAX_LENGTH}`}
        disabled={busy}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button onClick={() => void submit()} disabled={busy} fullWidth={false}>
        {busy ? "Sending…" : "Send my statement"}
      </Button>
    </div>
  );
}
