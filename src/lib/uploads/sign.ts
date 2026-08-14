/**
 * Short-lived signed URLs for private objects, minted with the service-role key.
 *
 * Server-only — never import this into a Client Component.
 *
 * The bucket is private and the storage policies are anchored on the object's
 * *owner*: a worker may read their own sample, and nobody else may. Two screens
 * legitimately need to show someone else's object anyway — the approval queue
 * (spec §7) and the client's shortlist (spec §5) — and neither is the owner. So
 * the URL is minted with the service-role key, always *after* the caller has
 * been checked. That is what migration 0004 means by "access to a file is a
 * decision, not a row predicate": the decision is made in the module above this
 * one, and this only carries it out.
 *
 * The rule for every caller: check who is asking first, pass only the keys that
 * answer survives, and keep the TTL as short as the screen can live with.
 */

import { createServiceRoleClient } from "@/lib/supabase/server";

/**
 * Signs each key, keyed by the storage key it came from. A failure is logged
 * and returns an empty map rather than throwing: a screen that lists captions,
 * file names and ratings is still worth rendering without its thumbnails.
 */
export async function signStorageObjects(
  bucket: string,
  storageKeys: string[],
  ttlSeconds: number,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (storageKeys.length === 0) return urls;

  const admin = createServiceRoleClient();
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUrls([...new Set(storageKeys)], ttlSeconds);

  if (error) {
    console.error(`[uploads] could not sign ${bucket} objects: ${error.message}`);
    return urls;
  }

  for (const entry of data ?? []) {
    if (entry.signedUrl && entry.path) urls.set(entry.path, entry.signedUrl);
  }

  return urls;
}
