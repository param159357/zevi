-- ============================================================================
-- Zevi 0004 — files
--
-- One table for every byte we store in R2, with per-domain junction tables
-- (job_attachments, delivery_files, …) added by the migrations that own those
-- domains. That avoids a polymorphic owner column while still letting the same
-- physical file be referenced from more than one place.
--
-- Retention (spec §12) is a two-part story and the columns reflect it:
--   * the R2 object is deleted on schedule    → storage_key, purged_at
--   * the evidence is kept forever            → sha256, original_name,
--     size_bytes, uploaded_at, preview_key
-- A purged row is never deleted. Six months after the fact, a chargeback is
-- argued from exactly these few KB.
--
-- Reads are deliberately narrow: the owner and admins can select rows; everyone
-- else receives a short-lived signed URL minted server-side after an
-- authorisation check. There is no policy that grants "the other party to the
-- job" direct access, because access depends on job state (watermarked before
-- acceptance, clean after) and that is a decision, not a row predicate.
-- ============================================================================

create table public.files (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references public.profiles (id) on delete restrict,
  purpose              public.file_purpose not null,
  bucket               text not null default 'zevi-uploads',
  storage_key          text not null unique,
  original_name        text not null,
  mime_type            text not null,
  size_bytes           bigint not null check (size_bytes > 0),
  -- Permanent evidence. Also the cheapest plagiarism signal we have: an exact
  -- re-upload of someone else's sample collides here.
  sha256               text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  width                integer,
  height               integer,
  duration_seconds     numeric(10, 2),
  page_count           integer,
  -- Watermarked derivative, kept after the original is purged.
  preview_key          text,
  preview_generated_at timestamptz,
  scan_status          public.file_scan_status not null default 'pending',
  scanned_at           timestamptz,
  uploaded_at          timestamptz not null default now(),
  -- Set when the job reaches a terminal state; the sweeper deletes the object.
  delete_after         timestamptz,
  retention_reason     text,
  purged_at            timestamptz,
  created_at           timestamptz not null default now()
);

create index files_owner_idx on public.files (owner_id, created_at desc);
create index files_purpose_idx on public.files (purpose, created_at desc);
create index files_sha256_idx on public.files (sha256);
-- The deletion sweep: due, not yet purged. Partial so it stays tiny.
create index files_deletion_due_idx on public.files (delete_after)
  where purged_at is null and delete_after is not null;
-- The virus/format scan queue.
create index files_scan_queue_idx on public.files (uploaded_at)
  where scan_status = 'pending';

alter table public.files enable row level security;

create policy "owners read their own files"
  on public.files for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "admins read every file record"
  on public.files for select to authenticated
  using ((select public.is_admin()));

create policy "users register their own uploads"
  on public.files for insert to authenticated
  with check (owner_id = (select auth.uid()) and purged_at is null);

-- Purging, previews and scan results are all server-side work.
revoke update, delete on public.files from anon, authenticated;

-- profiles.avatar_file_id could not be declared until this table existed.
alter table public.profiles
  add constraint profiles_avatar_file_fk
  foreign key (avatar_file_id) references public.files (id) on delete set null;

alter table public.public_profiles
  add constraint public_profiles_avatar_file_fk
  foreign key (avatar_file_id) references public.files (id) on delete set null;
