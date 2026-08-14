-- ============================================================================
-- Zevi 0023 — the upload bucket
--
-- Spec §3 puts files in Cloudflare R2 for the zero egress, and `public.files`
-- was written for it: `bucket` and `storage_key` name an object somewhere, and
-- nothing in the schema cares where. Supabase Storage stands in until R2 is
-- wired up, which makes this migration the temporary half — the bucket and its
-- policies go away, `public.files` does not.
--
-- Objects are keyed `<purpose>/<owner id>/<job id>/<uuid>.<ext>`, and every
-- policy below is anchored on the first two segments. A later purpose
-- (deliveries, samples, KYC) adds its own policy rather than inheriting one:
-- access to a delivery depends on job state — watermarked before acceptance,
-- clean after — and that is a decision made server-side, not a row predicate.
--
-- The bucket is private. Nothing is served from it directly; the app mints a
-- short-lived signed URL after checking who is asking.
-- ============================================================================

-- 500MB is the video cap from spec §12, and the largest of the three. Note that
-- a Supabase project also has a global upload limit which this cannot exceed —
-- raise it in the dashboard (Storage → Settings) before a 500MB upload works.
insert into storage.buckets (id, name, public, file_size_limit)
values ('zevi-uploads', 'zevi-uploads', false, 524288000)
on conflict (id) do update
  set public          = excluded.public,
      file_size_limit = excluded.file_size_limit;

drop policy if exists "clients upload their own job attachments" on storage.objects;
drop policy if exists "owners read their own job attachments" on storage.objects;
drop policy if exists "owners remove their own job attachments" on storage.objects;

-- The client uploads straight from the browser — a 500MB video has no business
-- passing through a Server Action. The row in `public.files` that makes the
-- object part of a job is written afterwards, server-side, against the size and
-- content type Storage reports rather than the ones the browser claimed.
create policy "clients upload their own job attachments"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'job-attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "owners read their own job attachments"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'job-attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- Removing an attachment while the job is still editable. The `public.files`
-- row survives it: spec §12 keeps the hash, name, size and timestamp forever,
-- because that is the evidence a chargeback is argued from months later.
create policy "owners remove their own job attachments"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'job-attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );
