"use client";

import { useFormStatus } from "react-dom";

import { Button, type ButtonVariant } from "@/components/ui/Button";

/**
 * Reads the pending state of the form it sits inside, so a slow signup can't be
 * submitted twice.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  fullWidth = true,
  disabled = false,
  className,
}: {
  children: string;
  pendingLabel?: string;
  variant?: ButtonVariant;
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant={variant}
      fullWidth={fullWidth}
      disabled={pending || disabled}
      aria-busy={pending}
      className={className}
    >
      {pending ? (pendingLabel ?? children) : children}
    </Button>
  );
}
