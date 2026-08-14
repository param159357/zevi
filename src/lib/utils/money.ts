/**
 * Money formatting and parsing.
 *
 * Pure, no I/O. Every amount in this codebase is an integer number of paise —
 * `₹149` is `14900` — and rupees exist only at the render edge, which is here.
 * Nothing in this file may return a float that another module then does
 * arithmetic on.
 */

export const PAISE_PER_RUPEE = 100;

const RUPEES = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const RUPEES_WHOLE = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/** `16488` → `₹164.88`. */
export function formatPaise(paise: number): string {
  return RUPEES.format(paise / PAISE_PER_RUPEE);
}

/** `₹149` rather than `₹149.00`, for headings and limits where paise are noise. */
export function formatPaiseCompact(paise: number): string {
  return paise % PAISE_PER_RUPEE === 0
    ? RUPEES_WHOLE.format(paise / PAISE_PER_RUPEE)
    : formatPaise(paise);
}

/**
 * What the client typed into a rupee field, as paise. Tolerates `₹`, grouping
 * commas and spaces; refuses anything else rather than guessing, and refuses
 * more than two decimal places rather than rounding money the user can see.
 */
export function parseRupeesToPaise(input: unknown): number | null {
  if (typeof input !== "string") return null;

  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const [rupees, fraction = ""] = cleaned.split(".");
  const paise = Number(rupees) * PAISE_PER_RUPEE + Number(fraction.padEnd(2, "0"));

  return Number.isSafeInteger(paise) ? paise : null;
}

/** Paise back into the string a rupee input should show: `14900` → `149`. */
export function paiseToRupeeInput(paise: number): string {
  return paise % PAISE_PER_RUPEE === 0
    ? String(paise / PAISE_PER_RUPEE)
    : (paise / PAISE_PER_RUPEE).toFixed(2);
}

/** Basis points as a percentage label: `450` → `4.5%`. */
export function formatBps(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0$/, "")}%`;
}
