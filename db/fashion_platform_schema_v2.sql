-- =====================================================================
-- fashion_platform_schema_v2.sql
-- Multi-tenant SaaS Fashion Platform — Schema v2
--
-- Referensi: CHECKPOINT.md bagian 2,3,5,6,7,8,9,13,19,22,23
-- Pola RLS: SET LOCAL app.tenant_id per transaction (lihat bagian 22)
-- Event contract: db/EVENT_CONTRACTS.md
--
-- Cara pakai:
--   supabase migration new schema_v2_core
--   (isi file migration yang di-generate dengan isi file ini)
--   supabase db push
-- =====================================================================

-- Extensions
create extension if not exists "pgcrypto";   -- gen_random_uuid(), crypt()
create extension if not exists "citext";     -- email/username case-insensitive

-- =====================================================================
-- 0. HELPER: role aplikasi TANPA privilege BYPASSRLS
-- (bagian 22, poin wajib #2 — jangan connect pakai role superuser/postgres)
-- =====================================================================
-- Dijalankan manual sekali oleh admin (butuh privilege lebih tinggi dari
-- migration biasa) — DIBIARKAN SEBAGAI CATATAN, bukan dieksekusi otomatis:
--
--   create role app_user with login password '<generate-random>' noinherit;
--   grant usage on schema public to app_user;
--   grant select, insert, update, delete on all tables in schema public to app_user;
--   alter default privileges in schema public
--     grant select, insert, update, delete on tables to app_user;
--
-- Pastikan app_user TIDAK punya BYPASSRLS (default-nya memang tidak ada,
-- tinggal jangan pernah grant itu).

-- =====================================================================
-- 1. TENANTS
-- =====================================================================
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subdomain citext not null unique,           -- namatenant.domain.com (bagian 3)
  tenant_type text not null check (tenant_type in
    ('brand_ready_stock','brand_custom','vendor_konveksi','custom_tailor','pabrik')),
  default_response_deadline_days int not null default 3,  -- bagian 9
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- tenants sendiri tidak punya tenant_id (dia induknya), tapi tetap RLS aktif:
-- akses hanya lewat service_role (backend admin), bukan lewat context tenant biasa.
alter table tenants enable row level security;

create policy tenants_service_only on tenants
  using (current_setting('role', true) = 'service_role')
  with check (current_setting('role', true) = 'service_role');


-- =====================================================================
-- 2. TENANT_BILLING (bagian 2)
-- =====================================================================
create table if not exists tenant_billing (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  billing_model text not null check (billing_model in
    ('per_transaction_fee','monthly_fee','annual_contract')),
  fee_amount numeric(12,2),
  fee_percentage numeric(5,2),
  currency text not null default 'IDR',
  billing_status text not null default 'active'
    check (billing_status in ('active','suspended','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_billing enable row level security;

create policy tenant_isolation on tenant_billing
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 3. TENANT_PIPELINE_STAGES (bagian 5, 13 — generalisasi STAGE_ORDER LTOS)
-- =====================================================================
create table if not exists tenant_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  stage_key text not null,               -- e.g. 'gudang','cutting','jahit','qc','finishing'
  stage_order int not null,
  is_gudang_stage boolean not null default false,  -- bagian 6
  is_optional boolean not null default false,      -- gudang opsional per tenant
  created_at timestamptz not null default now(),
  unique (tenant_id, stage_key),
  unique (tenant_id, stage_order)
);

alter table tenant_pipeline_stages enable row level security;

create policy tenant_isolation on tenant_pipeline_stages
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 4. STAFF (bagian 13 — dari tabel `staff` LTOS, sudah pakai pgcrypto PIN)
-- =====================================================================
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin','staff')),
  pin_hash text not null,                -- crypt(pin, gen_salt('bf'))
  assigned_stage text,                   -- references tenant_pipeline_stages.stage_key
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, full_name)
);

alter table staff enable row level security;

create policy tenant_isolation on staff
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 5. ORDERS (bagian 5, 9 — + checkout_policy_snapshot)
-- =====================================================================
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_name text not null,
  customer_contact text,
  status text not null default 'draft'
    check (status in ('draft','confirmed','in_production','completed','cancelled')),
  -- Snapshot kebijakan deadline & default action SAAT checkout (bagian 9) —
  -- supaya perubahan kebijakan tenant di kemudian hari tidak menimpa
  -- kesepakatan order lama.
  checkout_policy_snapshot jsonb not null default '{}'::jsonb,
  last_notified_qty int not null default 0,   -- agregasi notif reject massal (bagian 8)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table orders enable row level security;

create policy tenant_isolation on orders
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 6. ORDER_SPECS (bagian 5, 13 — fase WEB/konsultasi, belum ada di LTOS)
-- =====================================================================
create table if not exists order_specs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  spec_detail jsonb not null default '{}'::jsonb,   -- ukuran, model, dsb.
  quantity int not null check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table order_specs enable row level security;

create policy tenant_isolation on order_specs
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 7. ORDER_SPEC_MATERIALS (bagian 5)
-- =====================================================================
create table if not exists order_spec_materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_spec_id uuid not null references order_specs(id) on delete cascade,
  material_name text not null,
  quantity_needed numeric(12,3) not null,
  unit text not null,
  created_at timestamptz not null default now()
);

alter table order_spec_materials enable row level security;

create policy tenant_isolation on order_spec_materials
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 8. SPEC_SUBSTITUTION_REQUESTS (bagian 7 — ganti kain, approval 2 lapis)
-- =====================================================================
create table if not exists spec_substitution_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_spec_id uuid not null references order_specs(id) on delete cascade,
  requested_by_staff_id uuid references staff(id),
  original_material text not null,
  substitute_material text not null,
  reason text,
  -- Alur: admin_pin dulu (filter internal), baru ke customer (transparansi)
  admin_approval_status text not null default 'pending'
    check (admin_approval_status in ('pending','approved','rejected')),
  admin_approved_by_staff_id uuid references staff(id),
  admin_approved_at timestamptz,
  customer_decision_status text not null default 'pending'
    check (customer_decision_status in ('pending','approved','rejected')),
  customer_decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table spec_substitution_requests enable row level security;

create policy tenant_isolation on spec_substitution_requests
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 9. CUSTOMER_DECISIONS (bagian 8 — REFUND / WAIT_REPRODUCTION / CHOOSE_ALTERNATIVE)
-- =====================================================================
create table if not exists customer_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  decision_type text not null check (decision_type in
    ('REFUND','WAIT_REPRODUCTION','CHOOSE_ALTERNATIVE')),
  decision_detail jsonb not null default '{}'::jsonb,
  decided_at timestamptz,
  deadline_at timestamptz,              -- eskalasi bertahap (bagian 9)
  escalation_stage text not null default 'reminder'
    check (escalation_stage in ('reminder','manual_call','default_action_applied')),
  created_at timestamptz not null default now()
);

alter table customer_decisions enable row level security;

create policy tenant_isolation on customer_decisions
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 10. CUSTOMER_NOTIFICATIONS (bagian 8 — agregasi per order, anti-spam)
-- =====================================================================
create table if not exists customer_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  notification_type text not null check (notification_type in
    ('cancel_permanent','decision_needed','reminder')),
  channel text,                         -- e.g. 'whatsapp','email'
  sent_at timestamptz,
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending','sent','failed')),  -- nyusul: retry queue (bagian 19)
  created_at timestamptz not null default now()
);

alter table customer_notifications enable row level security;

create policy tenant_isolation on customer_notifications
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 11. FABRIC_INVENTORY (bagian 5)
-- =====================================================================
create table if not exists fabric_inventory (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  material_name text not null,
  -- state formal, nyusul dirapikan (bagian 19) — sudah dibuat eksplisit dari awal:
  stock_state text not null default 'AVAILABLE'
    check (stock_state in ('AVAILABLE','RESERVED','CONSUMED')),
  quantity numeric(12,3) not null default 0,
  unit text not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, material_name)
);

alter table fabric_inventory enable row level security;

create policy tenant_isolation on fabric_inventory
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 12. INVENTORY_LEDGER (bagian 5, 6 — STOCK_CONSUMED terjadi di cutting)
-- =====================================================================
create table if not exists inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  fabric_inventory_id uuid not null references fabric_inventory(id),
  order_id uuid references orders(id),
  movement_type text not null check (movement_type in
    ('RESERVED','STOCK_CONSUMED','RELEASED','RESTOCKED')),
  quantity numeric(12,3) not null,
  created_by_staff_id uuid references staff(id),
  created_at timestamptz not null default now()
);

alter table inventory_ledger enable row level security;

create policy tenant_isolation on inventory_ledger
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 13. PRODUCTION_JOBS (bagian 5, 13 — generalisasi order_state LTOS)
-- =====================================================================
create table if not exists production_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  current_stage text not null,          -- references tenant_pipeline_stages.stage_key
  current_version bigint not null default 0,   -- versioning.js pattern (bagian 13)
  gap_status text not null default 'CLOSED'
    check (gap_status in ('CLOSED','OPEN','RECOVERING','ESCALATED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, order_id)
);

alter table production_jobs enable row level security;

create policy tenant_isolation on production_jobs
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 14. PRODUCTION_EVENTS (bagian 5, 13, 23 — event-sourced, dari `events` LTOS)
-- Kontrak event: lihat db/EVENT_CONTRACTS.md
-- =====================================================================
create table if not exists production_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  production_job_id uuid not null references production_jobs(id) on delete cascade,
  event_type text not null,             -- e.g. 'order.created','qc.failed' (EVENT_CONTRACTS.md)
  event_version int not null default 1, -- backward compatibility (bagian 23)
  payload jsonb not null default '{}'::jsonb,
  sequence_version bigint not null,     -- strict versioning per entity (row lock, bagian 13)
  created_at timestamptz not null default now(),
  unique (tenant_id, production_job_id, sequence_version)
);

alter table production_events enable row level security;

create policy tenant_isolation on production_events
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 15. JOB_LOCKS (bagian 5, 13 — dari `order_locks` LTOS)
-- =====================================================================
create table if not exists job_locks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  production_job_id uuid not null references production_jobs(id) on delete cascade,
  locked_by_staff_id uuid not null references staff(id),
  locked_at timestamptz not null default now(),
  released_at timestamptz,
  admin_override boolean not null default false,   -- PIN admin override (bagian 13)
  unique (tenant_id, production_job_id, released_at)
);

alter table job_locks enable row level security;

create policy tenant_isolation on job_locks
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 16. WORK_LOG (bagian 5, 13)
-- =====================================================================
create table if not exists work_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  production_job_id uuid not null references production_jobs(id) on delete cascade,
  staff_id uuid not null references staff(id),
  stage text not null,
  action text not null,                 -- e.g. 'started','completed','force_unlock'
  logged_at timestamptz not null default now()
);

alter table work_log enable row level security;

create policy tenant_isolation on work_log
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 17. PRODUCTION_STAGE_PHOTOS (bagian 5, 13 — upload ke Supabase Storage, max 5MB)
-- =====================================================================
create table if not exists production_stage_photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  production_job_id uuid not null references production_jobs(id) on delete cascade,
  stage text not null,
  storage_path text not null,           -- path di Supabase Storage
  uploaded_by_staff_id uuid references staff(id),
  uploaded_at timestamptz not null default now()
);

alter table production_stage_photos enable row level security;

create policy tenant_isolation on production_stage_photos
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 18. PAYMENTS (bagian 5 — uang customer langsung ke tenant, bagian 2)
-- =====================================================================
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  amount numeric(14,2) not null,
  currency text not null default 'IDR',
  status text not null default 'initiated'
    check (status in ('initiated','received','failed')),
  payment_method text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table payments enable row level security;

create policy tenant_isolation on payments
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- 19. SHIPMENTS (bagian 5)
-- =====================================================================
create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','dispatched','delivered')),
  tracking_number text,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

alter table shipments enable row level security;

create policy tenant_isolation on shipments
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- =====================================================================
-- INDEXES — tenant_id di semua tabel (wajib untuk performa query ber-RLS)
-- =====================================================================
create index if not exists idx_tenant_billing_tenant on tenant_billing(tenant_id);
create index if not exists idx_pipeline_stages_tenant on tenant_pipeline_stages(tenant_id);
create index if not exists idx_staff_tenant on staff(tenant_id);
create index if not exists idx_orders_tenant on orders(tenant_id);
create index if not exists idx_order_specs_tenant on order_specs(tenant_id);
create index if not exists idx_order_spec_materials_tenant on order_spec_materials(tenant_id);
create index if not exists idx_substitution_requests_tenant on spec_substitution_requests(tenant_id);
create index if not exists idx_customer_decisions_tenant on customer_decisions(tenant_id);
create index if not exists idx_customer_notifications_tenant on customer_notifications(tenant_id);
create index if not exists idx_fabric_inventory_tenant on fabric_inventory(tenant_id);
create index if not exists idx_inventory_ledger_tenant on inventory_ledger(tenant_id);
create index if not exists idx_production_jobs_tenant on production_jobs(tenant_id);
create index if not exists idx_production_events_tenant on production_events(tenant_id);
create index if not exists idx_job_locks_tenant on job_locks(tenant_id);
create index if not exists idx_work_log_tenant on work_log(tenant_id);
create index if not exists idx_stage_photos_tenant on production_stage_photos(tenant_id);
create index if not exists idx_payments_tenant on payments(tenant_id);
create index if not exists idx_shipments_tenant on shipments(tenant_id);

-- Selesai.
