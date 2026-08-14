/**
 * Loading the rates the calculator works from.
 *
 * `commission_slabs` and `tax_rates` are versioned: a row is never updated to a
 * new rate, a new row is inserted and the old one closed. So every read is
 * "what applied at this moment", which for a quote is now and for a historical
 * job is the day it was priced.
 *
 * Both tables are public — every worker and client can see exactly what they
 * will be charged — so these run under the caller's own client, not a
 * service-role one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CommissionSlab } from "@/lib/money/commission";
import type { Database } from "@/types/database.types";

type AnySupabaseClient = SupabaseClient<Database>;

const SLAB_COLUMNS =
  "id, label, min_paise, max_paise, total_bps, client_bps, worker_bps, min_commission_paise, max_commission_paise";

/** GST on commission. A configurable line item, never a hardcoded 18%. */
export const COMMISSION_TAX_CODE = "gst_commission";

export type Rates = {
  slabs: CommissionSlab[];
  taxRateBps: number;
};

export async function loadCommissionSlabs(
  supabase: AnySupabaseClient,
  at: Date = new Date(),
): Promise<CommissionSlab[]> {
  const moment = at.toISOString();

  const { data, error } = await supabase
    .from("commission_slabs")
    .select(SLAB_COLUMNS)
    .lte("effective_from", moment)
    .or(`effective_to.is.null,effective_to.gt.${moment}`)
    .order("min_paise");

  if (error) throw new Error(`Could not load commission slabs: ${error.message}`);

  // An exclusion constraint guarantees no two slabs cover the same rupee at the
  // same moment, so an empty table is the only way this can be wrong — and that
  // is a broken deployment, not a pricing edge case.
  if (!data || data.length === 0) {
    throw new Error("No commission slabs are in effect. Check migration 0018.");
  }

  return data;
}

export async function loadCommissionTaxBps(
  supabase: AnySupabaseClient,
  at: Date = new Date(),
): Promise<number> {
  const moment = at.toISOString();

  const { data, error } = await supabase
    .from("tax_rates")
    .select("rate_bps")
    .eq("code", COMMISSION_TAX_CODE)
    .lte("effective_from", moment)
    .or(`effective_to.is.null,effective_to.gt.${moment}`)
    .maybeSingle();

  if (error) throw new Error(`Could not load the commission tax rate: ${error.message}`);
  if (!data) {
    throw new Error(
      `No '${COMMISSION_TAX_CODE}' rate is in effect. Check migration 0018.`,
    );
  }

  return data.rate_bps;
}

/** Both halves at once, for a screen that quotes a price. */
export async function loadRates(
  supabase: AnySupabaseClient,
  at: Date = new Date(),
): Promise<Rates> {
  const [slabs, taxRateBps] = await Promise.all([
    loadCommissionSlabs(supabase, at),
    loadCommissionTaxBps(supabase, at),
  ]);

  return { slabs, taxRateBps };
}
