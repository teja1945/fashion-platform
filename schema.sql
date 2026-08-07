-- ============================================================
-- LTOS — Schema inti. Satu Postgres = event store + state + gap buffer.
-- Prinsip yang dijaga: event = source of truth, state = projection,
-- strict per-entity versioning, replay-safe, action idempotent.
-- ============================================================

-- 1. EVENT STORE (append-only, tidak pernah di-UPDATE/DELETE)
CREATE TABLE IF NOT EXISTS events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,              -- format namespace: order.created
  event_version TEXT NOT NULL DEFAULT '1.0.0', -- semver schema event ini
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,       -- strict increment per entity_id
  source TEXT NOT NULL,
  request_id TEXT,                       -- untuk dedup transport-level
  is_synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  reconstructed_reason TEXT,             -- wajib diisi kalau is_synthetic = true
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- satu entity_id tidak boleh punya entity_version ganda
  CONSTRAINT uq_entity_version UNIQUE (entity_id, entity_version)
);

CREATE INDEX IF NOT EXISTS idx_events_entity ON events (entity_id, entity_version);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);

-- 2. REQUEST DEDUP (idempotency producer-level, transport retry)
-- Terpisah dari entity_version, sesuai koreksi yang sudah dikunci.
CREATE TABLE IF NOT EXISTS request_dedup (
  request_id TEXT PRIMARY KEY,
  event_id UUID REFERENCES events(event_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- TTL dikelola lewat job pembersihan berkala, bukan constraint DB.

-- 3. VERSION TRACKER per entity (dipakai State Layer, bukan dari offset broker)
CREATE TABLE IF NOT EXISTS state_version_tracker (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  is_consistent BOOLEAN NOT NULL DEFAULT TRUE, -- false kalau ada gap terbuka
  state_integrity TEXT NOT NULL DEFAULT 'OK',  -- OK | COMPROMISED (kalau pernah controlled-skip)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. GAP BUFFER — event yang datang out-of-order, menunggu versi sebelumnya
CREATE TABLE IF NOT EXISTS pending_events (
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  event_id UUID NOT NULL REFERENCES events(event_id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, entity_version)
);

-- 5. GAP TRACKING — status machine (OPEN/RECOVERING/RESOLVED/ESCALATED)
CREATE TABLE IF NOT EXISTS gap_status (
  entity_id TEXT PRIMARY KEY,
  missing_from_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | RECOVERING | RESOLVED | ESCALATED
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ
);

-- 6. STALE / DUPLICATE LOG (audit, bukan error)
CREATE TABLE IF NOT EXISTS stale_event_log (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  event_id UUID,
  reason TEXT NOT NULL, -- 'duplicate' | 'stale'
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. PROJECTION STATE — contoh untuk entity_type = 'order' (tailor domain)
-- Pesanan asli dari sudut pandang customer (root, TIDAK dipecah, quantity tetap)
CREATE TABLE IF NOT EXISTS customer_orders (
  id TEXT PRIMARY KEY,
  customer_name TEXT,
  model TEXT,
  total_quantity INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_state (
  entity_id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT,
  model TEXT,
  stage TEXT,               -- consultation | measurement | sewing | obras | qc | finishing | delivery
  assigned_artisan TEXT,
  deadline TIMESTAMPTZ,
  status TEXT DEFAULT 'active', -- active | delayed | done | cancelled
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parent_order_id TEXT REFERENCES customer_orders(id), -- root customer_orders (flat, bukan tree)
  quantity INTEGER NOT NULL DEFAULT 1,                 -- jumlah pcs di bundle ini
  split_from TEXT REFERENCES order_state(entity_id)    -- audit lineage, bundle ini pecahan dari mana
);

-- 8. ACTION EXECUTION LOG — mencegah side-effect terulang saat replay
CREATE TABLE IF NOT EXISTS action_execution_log (
  action_key TEXT PRIMARY KEY, -- {entity_id}:{event_name}:{entity_version}:{action_type}
  action_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SUCCESS | FAILED
  sent_at TIMESTAMPTZ,     -- null = belum pernah dikirim, aman retry kirim
  completed_at TIMESTAMPTZ,
  external_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. REALTIME NOTIFY -- War Room dengar perubahan lewat LISTEN/NOTIFY,
-- menggantikan fungsi pub-sub broker tanpa perlu Kafka.
CREATE OR REPLACE FUNCTION notify_order_state_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('order_state_changed', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_state_notify ON order_state;
CREATE TRIGGER trg_order_state_notify
  AFTER INSERT OR UPDATE ON order_state
  FOR EACH ROW EXECUTE FUNCTION notify_order_state_change();

-- 10. STAFF — akun login PIN per-orang, dipakai scanner.html
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS staff (
  staff_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff','admin')),
  assigned_stage TEXT
);
