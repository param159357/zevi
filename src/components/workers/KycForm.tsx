"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { PAN_REQUIRED_ABOVE_PAISE } from "@/lib/constants/kyc";
import { submitWorkerKyc } from "@/lib/kyc/actions";
import type { KycFieldErrors, KycSubmission, PayoutMethodType } from "@/lib/kyc/types";
import { formatPaiseCompact } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

const EMPTY: KycSubmission = {
  legalName: "",
  dateOfBirth: "",
  pan: "",
  methodType: "bank_account",
  ifsc: "",
  accountNumber: "",
  upiId: "",
};

/**
 * Spec §6's four fields, and the one warning that matters.
 *
 * Everything this form checks is checked again in `submitWorkerKyc()` and again
 * by a CHECK or a trigger. What it adds is the chance to fix a typo *before* the
 * penny drop goes out — which is not a nicety here, because a mistyped account
 * number that happens to exist comes back in a stranger's name, and spec §6
 * makes that a permanent block with no override. Hence the second account-number
 * field, which never leaves the browser, and the sentence above the button.
 */
export function KycForm({
  defaults,
  panRequired,
  panAvailable,
  attemptsLeft,
}: {
  defaults: { legalName: string | null; dateOfBirth: string | null };
  panRequired: boolean;
  panAvailable: boolean;
  attemptsLeft: number;
}) {
  const [values, setValues] = useState<KycSubmission>({
    ...EMPTY,
    legalName: defaults.legalName ?? "",
    dateOfBirth: defaults.dateOfBirth ?? "",
  });
  const [confirmAccount, setConfirmAccount] = useState("");
  const [fieldErrors, setFieldErrors] = useState<KycFieldErrors>({});
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bank = values.methodType === "bank_account";

  function update(field: keyof KycSubmission, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field as keyof KycFieldErrors]) return current;
      const { [field as keyof KycFieldErrors]: _removed, ...rest } = current;
      return rest;
    });
  }

  function chooseMethod(methodType: PayoutMethodType) {
    setValues((current) => ({ ...current, methodType }));
    setFieldErrors({});
    setMismatch(null);
  }

  async function submit() {
    if (bank && values.accountNumber !== confirmAccount) {
      setMismatch("The two account numbers don't match.");
      return;
    }

    setBusy(true);
    setError(null);
    setMismatch(null);
    setFieldErrors({});

    const result = await submitWorkerKyc(values);

    // On success the action revalidates and this form is replaced by the
    // pending or verified panel, so there is nothing to reset.
    if (!result.ok) {
      if (result.fieldErrors) setFieldErrors(result.fieldErrors);
      setError(result.error);
      setBusy(false);
    }
  }

  return (
    <div className="border-border space-y-5 rounded-xl border p-5">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <TextField
        name="legalName"
        label="Your name, exactly as your bank has it"
        hint="Not a nickname. This is compared against the name on the account."
        value={values.legalName}
        onChange={(event) => update("legalName", event.target.value)}
        error={fieldErrors.legalName}
        autoComplete="name"
        maxLength={120}
      />

      <TextField
        name="dateOfBirth"
        type="date"
        label="Date of birth"
        hint="You have to be 18 to be paid through Zevi."
        value={values.dateOfBirth}
        onChange={(event) => update("dateOfBirth", event.target.value)}
        error={fieldErrors.dateOfBirth}
        autoComplete="bday"
      />

      {panAvailable ? (
        <TextField
          name="pan"
          label={panRequired ? "PAN" : "PAN (optional for now)"}
          hint={
            panRequired
              ? `You've earned over ${formatPaiseCompact(PAN_REQUIRED_ABOVE_PAISE)}, so we need this for TDS.`
              : `Only needed once you've earned ${formatPaiseCompact(PAN_REQUIRED_ABOVE_PAISE)}. Adding it now saves a step later.`
          }
          value={values.pan}
          onChange={(event) => update("pan", event.target.value.toUpperCase())}
          error={fieldErrors.pan}
          autoComplete="off"
          spellCheck={false}
          placeholder="ABCDE1234F"
          maxLength={10}
        />
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Where should we send your money?</legend>

        <div className="flex gap-2">
          {(
            [
              ["bank_account", "Bank account"],
              ["upi", "UPI ID"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className={cn(
                "flex-1 cursor-pointer rounded-lg border px-3 py-2.5 text-sm transition-colors",
                values.methodType === value
                  ? "border-accent bg-surface-muted"
                  : "border-border hover:bg-surface-muted",
              )}
            >
              <input
                type="radio"
                name="methodType"
                value={value}
                checked={values.methodType === value}
                onChange={() => chooseMethod(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {bank ? (
        <>
          <TextField
            name="ifsc"
            label="IFSC"
            hint="On your cheque book, or in your banking app under account details."
            value={values.ifsc}
            onChange={(event) => update("ifsc", event.target.value.toUpperCase())}
            error={fieldErrors.ifsc}
            autoComplete="off"
            spellCheck={false}
            placeholder="HDFC0000053"
            maxLength={11}
          />

          <TextField
            name="accountNumber"
            label="Account number"
            inputMode="numeric"
            value={values.accountNumber}
            onChange={(event) => update("accountNumber", event.target.value)}
            error={fieldErrors.accountNumber}
            autoComplete="off"
            spellCheck={false}
            maxLength={18}
          />

          <TextField
            name="confirmAccount"
            label="Account number again"
            hint="Worth the ten seconds — see below."
            inputMode="numeric"
            value={confirmAccount}
            onChange={(event) => {
              setConfirmAccount(event.target.value);
              setMismatch(null);
            }}
            error={mismatch ?? undefined}
            autoComplete="off"
            spellCheck={false}
            maxLength={18}
            onPaste={(event) => event.preventDefault()}
          />
        </>
      ) : (
        <TextField
          name="upiId"
          label="UPI ID"
          hint="The handle money is sent to, like yourname@okhdfcbank."
          value={values.upiId}
          onChange={(event) => update("upiId", event.target.value)}
          error={fieldErrors.upiId}
          autoComplete="off"
          spellCheck={false}
          placeholder="yourname@okhdfcbank"
        />
      )}

      {/*
        The one thing on this screen a worker has to read before they act. Spec
        §6 makes a name mismatch permanent and unappealable, which means the cost
        of a mistyped digit is the account — so the consequence is stated plainly
        and next to the button, not buried in terms.
      */}
      <Alert tone="info">
        We&apos;ll send ₹1 to that account to see whose name is on it. If the name
        that comes back isn&apos;t yours, we can&apos;t verify the account and that
        can&apos;t be reversed — so check the digits before you send this. You have{" "}
        {attemptsLeft} {attemptsLeft === 1 ? "attempt" : "attempts"} left.
      </Alert>

      <Button onClick={() => void submit()} disabled={busy} fullWidth>
        {busy ? "Checking with your bank…" : "Verify my account"}
      </Button>
    </div>
  );
}
