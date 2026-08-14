import { redirect } from "next/navigation";

import { ADMIN_ROUTES } from "@/lib/constants/workers";

/**
 * Spec §7: the console's home is a work queue, not a stats dashboard, ordered
 * by what is rotting — disputes past SLA, approvals nearing 24 hours, jobs
 * about to expire, failed payouts. Worker approvals is the only one of those
 * that exists yet, so this lands there rather than pretending to be a shell for
 * five queues that do not.
 */
export default function AdminHomePage() {
  redirect(ADMIN_ROUTES.approvals);
}
