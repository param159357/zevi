/**
 * The one-way half of KYC.
 *
 * **Server-only.** Reads `KYC_HASH_PEPPER` through `serverEnv`; importing it
 * from a Client Component puts the pepper in the browser bundle, which defeats
 * the entire point of it.
 *
 * A worker's full PAN and full bank account number pass through this process on
 * their way to Razorpay and are never written to the database. What is kept is
 * the last four digits — enough for the worker to recognise their own account —
 * and a keyed HMAC, which is enough for the only two questions the platform ever
 * asks of the whole value:
 *
 *   one PAN per account       `worker_kyc.pan_hash`, spec §6
 *   two accounts, one bank    `payout_methods.destination_hash`, spec §10's
 *                             collusion signal
 *
 * HMAC and not a bare digest because a PAN is five letters, four digits and a
 * letter — a space small enough to enumerate against a stolen table in an
 * afternoon, and a bank account number is worse. The key lives in the
 * application environment, so a copy of the database answers neither question
 * for an attacker while still answering both for us.
 *
 * Both hashes are hex SHA-256, which is what the `^[a-f0-9]{64}$` CHECKs on the
 * two columns already require.
 */

import { createHmac } from "node:crypto";

import { serverEnv } from "@/lib/env";

/**
 * Namespaced so the same digits cannot collide across two meanings. A PAN and an
 * account number are different facts about a person and a shared hash space
 * would let one be tested against the other.
 */
function keyedHash(namespace: string, value: string): string {
  return createHmac("sha256", serverEnv.kycHashPepper)
    .update(`${namespace}:${value}`, "utf8")
    .digest("hex");
}

/** Takes the PAN already uppercased by `parsePan`. Case would otherwise make one
 *  PAN two hashes and the duplicate check would never fire. */
export function panHash(pan: string): string {
  return keyedHash("pan", pan);
}

/**
 * A bank destination is the account number *and* the branch — the same digits at
 * two banks are two accounts, and IFSC is what tells them apart.
 */
export function bankDestinationHash(accountNumber: string, ifsc: string): string {
  return keyedHash("bank", `${accountNumber}|${ifsc}`);
}

/** Takes the handle already lowercased by `parseUpiId`, for the same reason
 *  `panHash` takes it uppercased. */
export function upiDestinationHash(vpa: string): string {
  return keyedHash("upi", vpa);
}
