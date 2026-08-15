import { redirect } from "next/navigation";

import { adminCan } from "@/lib/admin/session";
import { ADMIN_ROUTES } from "@/lib/constants/workers";

/**
 * Spec §7: the console's home is a work queue, not a stats dashboard, ordered
 * by what is rotting — disputes past SLA, approvals nearing 24 hours, jobs
 * about to expire, failed payouts. Two of those exist, so this lands on
 * whichever the account can actually open rather than pretending to be a shell
 * for five queues that do not.
 *
 * Order matters only when someone holds both: approvals runs against a 24-hour
 * SLA and KYC does not, so the clock goes first.
 */
export default async function AdminHomePage() {
  if (await adminCan("review_workers")) redirect(ADMIN_ROUTES.approvals);
  if (await adminCan("manage_payouts")) redirect(ADMIN_ROUTES.kyc);

  // An admin with neither — a `support` account, say. The layout has already
  // established they belong in the console; there is simply nothing built yet
  // for them to do in it.
  redirect(ADMIN_ROUTES.approvals);
}
