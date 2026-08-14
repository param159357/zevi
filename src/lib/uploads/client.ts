/**
 * Browser-side upload helpers, shared by the two things that upload: a client's
 * job attachments (spec §5) and a worker's samples (spec §6).
 *
 * Both follow the same shape — the object goes straight from the browser to
 * storage, because a 500MB source video has no business travelling through a
 * Server Action, and only then does a Server Action turn it into a `files` row
 * against the size and type storage reports rather than the ones claimed here.
 *
 * The SHA-256 is provisional: it reads the whole file into memory, and when
 * uploads move to R2 the hash should be taken at the storage edge instead. It is
 * evidence for a chargeback months later (spec §12), not an access check, and
 * the uploader hashing their own file is the least load-bearing version of it.
 */

/** `brief.final.pdf` → `<uuid>.pdf`. The original name is kept on the row. */
export function objectName(fileName: string): string {
  const extension = fileName.split(".").pop() ?? "";
  const safe = /^[A-Za-z0-9]{1,10}$/.test(extension) ? `.${extension.toLowerCase()}` : "";
  return `${crypto.randomUUID()}${safe}`;
}

export async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
