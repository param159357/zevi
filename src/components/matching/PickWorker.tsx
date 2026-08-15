"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { CHECKOUT_SCRIPT_URL } from "@/lib/constants/payments";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { SHORTLIST_PICKED_PARAM } from "@/lib/constants/matching";
import { confirmJobPayment, startJobPayment } from "@/lib/payments/actions";
import { formatPaise } from "@/lib/utils/money";

/**
 * Picking a worker, and paying for it — spec §4, step 5.
 *
 * Two taps, and the confirm step is not politeness. Assignment takes a lock,
 * closes the job, turns every other opt-in into a rejection and now charges a
 * card. There is no undo — cancelling afterwards costs the client ₹15 and the
 * worker their slot — and the button sits in a list of rows that look alike.
 *
 * The three states the client can end up in, and what each one is allowed to
 * offer:
 *
 *   * **nothing charged** — checkout dismissed, card declined, order refused.
 *     Retry is safe, so retry is offered
 *   * **charged and assigned** — the page navigates and shows who got the job
 *   * **charged, not assigned** — the one state where a retry button would be
 *     actively harmful. `ConfirmPaymentResult.retryable` is false and this
 *     shows a message with no way to pay again. The `payment.captured` webhook
 *     finishes the job from the other side
 */
export function PickWorker({
  jobId,
  optInId,
  workerName,
  clientTotalPaise,
}: {
  jobId: string;
  optInId: string;
  workerName: string;
  /** What the client pays, recomputed on the server. Shown before the modal
   *  opens so the confirm step names a figure rather than a promise. */
  clientTotalPaise: number | null;
}) {
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stuck, setStuck] = useState<string | null>(null);

  // Checkout runs its callbacks after this component may already be gone —
  // a dismissed modal on a page that navigated, for instance.
  //
  // Set on mount as well as cleared on unmount: StrictMode mounts, cleans up
  // and mounts again in development, and a ref that is only ever cleared stays
  // false through the second mount, which would silently swallow every result.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const settle = useCallback(
    async (response: RazorpayCheckoutResponse, paymentId: string) => {
      const result = await confirmJobPayment({
        paymentId,
        razorpayPaymentId: response.razorpay_payment_id,
        razorpaySignature: response.razorpay_signature,
      });

      if (!mounted.current) return;

      if (result.ok) {
        // Straight to the record of the decision. `replace`, not `push`: the
        // shortlist as it was before the pick is not a page to go back to.
        router.replace(
          `${JOB_ROUTES.shortlist(jobId)}?${SHORTLIST_PICKED_PARAM}=${result.workerId}`,
        );
        router.refresh();
        return;
      }

      setBusy(false);
      setConfirming(false);

      if (result.retryable) {
        setError(result.error);
      } else {
        // Money taken, job not assigned. No retry — see the docstring.
        setStuck(result.error);
      }
    },
    [jobId, router],
  );

  const pay = useCallback(async () => {
    setBusy(true);
    setError(null);

    const started = await startJobPayment({ jobId, optInId });

    if (!mounted.current) return;

    if (!started.ok) {
      setError(started.error);
      setBusy(false);
      setConfirming(false);
      return;
    }

    const Checkout = await loadCheckout();

    if (!mounted.current) return;

    if (!Checkout) {
      setError("We couldn't open the payment window. Check your connection and try again.");
      setBusy(false);
      return;
    }

    const { checkout } = started;

    const razorpay = new Checkout({
      key: checkout.keyId,
      amount: checkout.amountPaise,
      currency: checkout.currency,
      name: "Zevi",
      description: `${checkout.jobTitle} — ${checkout.workerName}`,
      order_id: checkout.orderId,
      prefill: {
        ...(checkout.prefill.name ? { name: checkout.prefill.name } : {}),
        ...(checkout.prefill.email ? { email: checkout.prefill.email } : {}),
        ...(checkout.prefill.contact ? { contact: checkout.prefill.contact } : {}),
      },
      handler: (response) => void settle(response, checkout.paymentId),
      modal: {
        ondismiss: () => {
          if (!mounted.current) return;
          setBusy(false);
          setConfirming(false);
          setError("Payment cancelled — nothing was charged and the job is still open.");
        },
      },
    });

    razorpay.on("payment.failed", (failure) => {
      if (!mounted.current) return;
      setBusy(false);
      setConfirming(false);
      setError(
        failure.error?.description ??
          "That payment didn't go through. Nothing was charged — try again.",
      );
    });

    razorpay.open();
  }, [jobId, optInId, settle]);

  if (stuck) {
    return (
      <p className="text-danger text-xs" role="alert">
        {stuck}
      </p>
    );
  }

  if (!confirming) {
    return (
      <div className="space-y-2">
        {error ? (
          <p className="text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Pick {workerName}
        </Button>
      </div>
    );
  }

  return (
    <div className="border-border bg-surface-muted space-y-3 rounded-lg border p-3">
      <p className="text-sm">
        Assign this job to {workerName}
        {clientTotalPaise === null ? "" : ` and pay ${formatPaise(clientTotalPaise)}`}? The
        money is held until you accept the work. Everyone else who opted in is told they
        weren&apos;t picked, and the job closes to new opt-ins.
      </p>

      {error ? (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void pay()} disabled={busy} aria-busy={busy}>
          {busy ? "Opening payment…" : `Pay and pick ${workerName}`}
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Razorpay Checkout, fetched the first time someone decides to pay.
 *
 * Not in the page's initial JavaScript on purpose. The shortlist is a screen a
 * client reads and re-reads while deciding, and a third-party payment script
 * has no business loading on every one of those visits.
 *
 * Resolves to null rather than throwing: a blocked or failed script is a
 * network problem the client can act on, not an exception.
 */
let checkoutScript: Promise<boolean> | null = null;

async function loadCheckout(): Promise<Window["Razorpay"] | null> {
  if (window.Razorpay) return window.Razorpay;

  checkoutScript ??= new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => {
      // Let the next attempt try again rather than caching the failure.
      checkoutScript = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return (await checkoutScript) ? (window.Razorpay ?? null) : null;
}
