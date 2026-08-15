/**
 * Razorpay Checkout, as much of it as `PickWorker` uses.
 *
 * The script is loaded from Razorpay's own origin at the moment a client
 * decides to pay — card details must never touch an origin of ours — so there
 * is no package to take types from and this is the declaration.
 *
 * Everything the handler returns is untrusted. It arrives through the user's
 * own browser, and the server re-reads all three values against our payment row
 * and Razorpay's API before a rupee is recorded. Typing them does not make them
 * true; it only stops the component inventing a fourth field.
 */

type RazorpayCheckoutResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayFailure = {
  error?: {
    code?: string;
    description?: string;
    reason?: string;
  };
};

type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler?: (response: RazorpayCheckoutResponse) => void;
  modal?: { ondismiss?: () => void; escape?: boolean };
};

type RazorpayInstance = {
  open: () => void;
  close: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayFailure) => void) => void;
};

interface Window {
  Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
}
