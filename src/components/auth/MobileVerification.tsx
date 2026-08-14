"use client";

import { useActionState, useEffect, useState } from "react";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { confirmMobileOtp, sendMobileOtp } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";
import { OTP_LENGTH } from "@/lib/constants/auth";
import { formatMobile } from "@/lib/utils/validation";

export function MobileVerification({ defaultMobile }: { defaultMobile: string | null }) {
  const [sendState, sendAction] = useActionState(sendMobileOtp, IDLE_FORM_STATE);
  const [confirmState, confirmAction] = useActionState(confirmMobileOtp, IDLE_FORM_STATE);
  const [editingNumber, setEditingNumber] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // Keyed on the state object rather than the number: two sends in a row both
  // return 60, and a value dependency would skip the second countdown.
  useEffect(() => {
    if (sendState.status === "sent") setEditingNumber(false);

    const seconds = sendState.retryAfterSeconds ?? 0;
    setResendIn(seconds);
    if (seconds <= 0) return;

    const timer = window.setInterval(() => {
      setResendIn((value) => (value <= 1 ? 0 : value - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [sendState]);

  const mobile = sendState.mobile ?? defaultMobile;
  const codeSent = !editingNumber && (sendState.status === "sent" || confirmState.status === "sent");
  const problem = confirmState.error ?? sendState.error;

  if (!codeSent) {
    return (
      <form action={sendAction} className="space-y-4" noValidate>
        {problem ? <Alert tone="error">{problem}</Alert> : null}

        <TextField
          name="mobile"
          label="Mobile number"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          prefix="+91"
          placeholder="98765 43210"
          defaultValue={mobile?.replace(/^\+91/, "") ?? ""}
          required
          error={sendState.fieldErrors?.mobile}
        />

        <SubmitButton pendingLabel="Sending the code…">Send me a code</SubmitButton>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {!problem && sendState.notice ? <Alert tone="success">{sendState.notice}</Alert> : null}

      <form action={confirmAction} className="space-y-4" noValidate>
        <TextField
          name="otp"
          label={`${OTP_LENGTH}-digit code`}
          hint={mobile ? `Sent to ${formatMobile(mobile)}.` : undefined}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={OTP_LENGTH}
          className="font-mono tracking-[0.4em]"
          placeholder={"0".repeat(OTP_LENGTH)}
          autoFocus
          required
          error={confirmState.fieldErrors?.otp ?? confirmState.fieldErrors?.mobile}
        />

        <SubmitButton pendingLabel="Checking…">Verify mobile</SubmitButton>
      </form>

      <div className="flex items-center justify-between gap-3">
        <form action={sendAction}>
          {mobile ? <input type="hidden" name="mobile" value={mobile} /> : null}
          <SubmitButton
            variant="ghost"
            fullWidth={false}
            disabled={resendIn > 0}
            pendingLabel="Sending…"
          >
            {resendIn > 0 ? `Send again in ${resendIn}s` : "Send a new code"}
          </SubmitButton>
        </form>

        <Button variant="ghost" onClick={() => setEditingNumber(true)}>
          Use a different number
        </Button>
      </div>
    </div>
  );
}
