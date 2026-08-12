-- ============================================================================
-- Zevi 0018 — reference data
--
-- This is a migration rather than supabase/seed.sql because the app cannot
-- price a job without a slab, cannot issue an invoice without a tax rate and
-- cannot charge a cancellation without a fee row. That is schema-adjacent
-- reference data, not fixtures — it has to exist in production too.
--
-- Every insert is ON CONFLICT DO NOTHING so re-running against a partially
-- seeded database is safe.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Admin roles — support can see disputes and cannot touch payouts (spec §7)
-- ----------------------------------------------------------------------------

insert into public.admin_roles (code, name, description, is_super, permissions) values
  ('super_admin', 'Super admin', 'Everything. One holder at launch.', true, '{}'),
  ('support', 'Support', 'Disputes, reports and tickets. No money.', false,
    array['view_disputes', 'resolve_disputes', 'resolve_reports', 'handle_support']::public.admin_permission[]),
  ('reviewer', 'Reviewer', 'Worker approvals and the category queue.', false,
    array['review_workers', 'manage_categories']::public.admin_permission[]),
  ('finance', 'Finance', 'Payout batches, the ledger and the failed-payout queue.', false,
    array['manage_payouts', 'view_finance', 'view_audit_log']::public.admin_permission[])
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- Commission slabs (spec §8)
--
-- The client's share is always the larger one: workers are the scarce side.
-- Descending by design — 11% on a ₹10,000 job is the number that makes two
-- people swap phone numbers.
-- ----------------------------------------------------------------------------

insert into public.commission_slabs
  (label, min_paise, max_paise, total_bps, client_bps, worker_bps, min_commission_paise, max_commission_paise)
values
  ('₹149–499',     14900,  49999, 1300, 700, 600, 2500, null),
  ('₹500–1,999',   50000, 199999, 1100, 600, 500, 2500, null),
  ('₹2,000–4,999',200000, 499999,  900, 500, 400, 2500, null),
  ('₹5,000+',     500000,   null,  800, 450, 350, 2500, 150000)
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Tax and fixed fees
-- ----------------------------------------------------------------------------

insert into public.tax_rates (code, name, rate_bps, applies_to, note) values
  ('gst_commission', 'GST on commission', 1800, 'commission',
   'Confirm with a CA before launch. Shown as its own line on both sides.'),
  ('gst_subscription', 'GST on subscription', 1800, 'subscription', null)
on conflict do nothing;

insert into public.fee_schedule (code, name, amount_paise, waived_below_paise, note) values
  ('cancellation', 'Cancellation fee', 1500, null,
   'Never charged when no worker opted in — that failure is ours, not the client''s.'),
  ('dispute', 'Dispute fee', 1500, null, 'Charged to the loser; a split splits the fee.'),
  ('instant_payout', 'Instant payout fee', 1500, null, 'Post-launch.')
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Subscription plans (post-launch — inactive until they are switched on)
-- ----------------------------------------------------------------------------

insert into public.subscription_plans
  (code, name, audience, price_paise, commission_discount_bps, unlimited_opt_ins, opt_in_limit,
   free_instant_payouts, guaranteed_shortlist, featured_placement, unlimited_rehire,
   brief_templates, priority_disputes, gst_invoicing, is_active)
values
  ('zevi_pro',      'Zevi Pro',      'worker', 14900, 100, true,  100, 8, false, false, false, false, false, false, false),
  ('zevi_pro_plus', 'Zevi Pro+',     'worker', 39900, 200, true,  100, 8, true,  true,  false, false, false, false, false),
  ('zevi_business', 'Zevi Business', 'client', 49900, 200, false, null, 0, false, false, true,  true,  true,  true,  false)
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- Platform ledger accounts
-- ----------------------------------------------------------------------------

insert into public.ledger_accounts (type, owner_id, code, name) values
  ('escrow',             null, 'escrow',             'Client funds held in escrow'),
  ('platform_revenue',   null, 'platform_revenue',   'Commission earned'),
  ('tax_payable',        null, 'tax_payable',        'GST collected, payable'),
  ('gateway_fees',       null, 'gateway_fees',       'Razorpay charges'),
  ('chargeback_reserve', null, 'chargeback_reserve', 'Reserve — never counted as profit'),
  ('penalty_receivable', null, 'penalty_receivable', 'Debits owed by workers'),
  ('external',           null, 'external',           'The world outside Zevi')
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- Settings
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public) values
  ('job.min_budget_paise', '14900', 'int', 'Minimum job budget: ₹149.', true),
  ('job.max_budget_paise', '500000', 'int',
   'Job value cap. ₹5,000 for the first three months (spec §10) — raise deliberately.', true),
  ('job.open_expiry_days', '7', 'int', 'An unassigned job expires after this many days.', false),
  ('job.manual_review_above_paise', '200000', 'int',
   'Manual admin review on a client''s first job above ₹2,000.', false),

  ('matching.max_active_opt_ins', '5', 'int', 'Active opt-ins per worker.', true),
  ('matching.dwell_seconds', '20', 'int', 'Dwell before the opt-in button activates.', true),
  ('matching.shortlist_size', '5', 'int', 'Shortlist slots: 1 top, 3 middle, 1 newest.', false),
  ('matching.newest_slot_max_shortlists', '10', 'int',
   'Newest-slot rotation: appearances before a worker rotates out.', false),
  ('matching.newest_slot_max_days', '14', 'int', 'Newest-slot rotation: days before rotating out.', false),

  ('delivery.auto_accept_hours_under_1000', '36', 'int', 'Auto-accept window under ₹1,000.', true),
  ('delivery.auto_accept_days_from_1000', '3', 'int', 'Auto-accept window at ₹1,000 and above.', true),
  ('delivery.free_revisions', '1', 'int', 'Free revisions per job.', true),

  ('payout.eligibility_hours', '48', 'int', 'Hours after acceptance before an earning matures.', true),
  ('payout.new_client_hold_days', '14', 'int', 'Payout hold on a new client''s first jobs.', false),
  ('payout.new_client_job_threshold', '3', 'int', 'How many of a client''s jobs are held.', false),

  ('commission.discount_cap_bps', '200', 'int', 'Loyalty + subscription discounts, capped at 2%.', false),
  ('finance.reserve_bps', '200', 'int', 'Reserve 2% of monthly GMV. Never counted as profit.', false),

  ('files.retention_days_accepted', '7', 'int', 'Delete delivered files 7 days after acceptance.', true),
  ('files.retention_days_disputed', '30', 'int', 'Delete 30 days after a dispute closes.', true),
  ('files.max_bytes_video', '524288000', 'int', 'Upload cap: video, 500MB.', true),
  ('files.max_bytes_design', '104857600', 'int', 'Upload cap: design, 100MB.', true),
  ('files.max_bytes_document', '26214400', 'int', 'Upload cap: documents, 25MB.', true),

  ('dispute.instant_split_below_paise', '30000', 'int', 'Under ₹300: instant 50/50, one tap each.', false),
  ('dispute.self_settlement_hours', '24', 'int', 'Layer 2 window.', true),
  ('dispute.first_response_hours', '48', 'int', 'Zevi''s first response.', true),
  ('dispute.decision_days', '5', 'int', 'Time to a decision.', true),
  ('dispute.appeal_hours', '48', 'int', 'One appeal, new evidence only.', true),

  ('worker.approval_sla_hours', '24', 'int', 'Sample review SLA.', false),
  ('worker.resubmit_after_days', '7', 'int', 'A rejected worker may resubmit once, after 7 days.', true),
  ('worker.grace_jobs', '3', 'int',
   'First jobs where sub-3 ratings stay off the public record. Admins see them from job one.', false),
  ('worker.tier_top_min_jobs', '10', 'int', 'Top tier: minimum completed jobs.', false),
  ('worker.tier_established_min_jobs', '5', 'int', 'Established tier: minimum completed jobs.', false),

  ('support.sla_hours', '48', 'int', 'Support response target.', true),
  ('rate_limit.requests_per_minute', '60', 'int', 'Per-user API ceiling.', false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- Rating tags — three quick tags alongside the stars
-- ----------------------------------------------------------------------------

insert into public.rating_tags (code, label, direction, sentiment, position) values
  ('followed_brief',    'Followed the brief',  'client_to_worker', 'positive', 1),
  ('on_time',           'Delivered on time',   'client_to_worker', 'positive', 2),
  ('clear_communication','Communicated well',  'client_to_worker', 'positive', 3),
  ('great_quality',     'Great quality',       'client_to_worker', 'positive', 4),
  ('needed_chasing',    'Needed chasing',      'client_to_worker', 'negative', 5),
  ('missed_brief',      'Missed the brief',    'client_to_worker', 'negative', 6),
  ('delivered_late',    'Delivered late',      'client_to_worker', 'negative', 7),
  ('clear_brief',       'Clear brief',         'worker_to_client', 'positive', 1),
  ('quick_replies',     'Replied quickly',     'worker_to_client', 'positive', 2),
  ('fair_feedback',     'Fair feedback',       'worker_to_client', 'positive', 3),
  ('vague_brief',       'Vague brief',         'worker_to_client', 'negative', 4),
  ('slow_replies',      'Slow to reply',       'worker_to_client', 'negative', 5),
  ('scope_creep',       'Kept adding work',    'worker_to_client', 'negative', 6)
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- Launch categories — two, deliberately (spec §17)
--
-- Twenty workers across two categories looks healthy; across eight it looks
-- abandoned.
-- ----------------------------------------------------------------------------

insert into public.categories
  (slug, name, description, status, position, max_upload_bytes, sample_format_note, requires_watermark)
values
  ('presentation-design', 'Presentation design',
   'Decks, pitch slides, templates and slide clean-ups.',
   'active', 1, 26214400, 'Upload the actual file or a PDF export — not screenshots.', true),
  ('video-editing', 'Video editing',
   'Reels, shorts, cuts, subtitles and simple motion work.',
   'active', 2, 524288000, 'Up to 60 seconds per sample.', true),
  ('other', 'Other',
   'Anything else. Goes to the admin queue and becomes the roadmap for new categories.',
   'active', 99, 104857600, null, true)
on conflict (slug) do nothing;

-- Structured brief fields: the cheapest dispute prevention there is (spec §11).
insert into public.category_brief_fields
  (category_id, key, label, type, is_required, options, min_value, max_value, unit, position)
select c.id, f.key, f.label, f.type::public.brief_field_type, f.is_required, f.options,
       f.min_value, f.max_value, f.unit, f.position
from public.categories c
join (values
  ('presentation-design', 'slide_count',   'How many slides?',        'number',      true,  '{}'::text[], 1,   200,  'slides',  1),
  ('presentation-design', 'file_format',   'Deliver as',              'select',      true,  array['PPTX', 'Google Slides', 'Keynote', 'PDF'], null, null, null, 2),
  ('presentation-design', 'brand_assets',  'Brand assets provided?',  'boolean',     true,  '{}'::text[], null, null, null,     3),
  ('presentation-design', 'content_ready', 'Is the content written?', 'boolean',     true,  '{}'::text[], null, null, null,     4),
  ('video-editing',       'duration',      'Final length',            'number',      true,  '{}'::text[], 5,   3600, 'seconds', 1),
  ('video-editing',       'aspect_ratio',  'Aspect ratio',            'select',      true,  array['16:9', '9:16', '1:1', '4:5'], null, null, null, 2),
  ('video-editing',       'footage_ready', 'Footage provided?',       'boolean',     true,  '{}'::text[], null, null, null,     3),
  ('video-editing',       'subtitles',     'Subtitles needed?',       'boolean',     false, '{}'::text[], null, null, null,     4),
  ('video-editing',       'file_format',   'Deliver as',              'select',      true,  array['MP4', 'MOV', 'Project file'], null, null, null, 5)
) as f (category_slug, key, label, type, is_required, options, min_value, max_value, unit, position)
  on f.category_slug = c.slug
on conflict (category_id, key) do nothing;
