# Phase 2 — Database Schema

PostgreSQL 15+. All timestamps are `timestamptz` stored in UTC. UUID v7 PKs
(time-ordered) where available, else UUID v4.

## 1. ER Diagram

```
organizations ──1:N── sites ──1:N── devices
      │                  │
      │                  ├──1:N── site_settings (1:1 effective)
      │                  │
      ├──1:N── vendors    └──1:N── attendance_sessions
      │           │
      │           └──1:N── workers ──1:N── attendance_sessions
      │                       │     └──1:N── worker_site_assignments
      │                       │
      │                       └──1:N── attendance_taps
      │
      ├──1:N── users ──N:M── user_site_scopes ──N:1── sites
      │           │
      │           └──1:N── refresh_tokens
      │
shifts ──N:1── sites
attendance_sessions ──1:N── correction_requests ──1:N── correction_items
audit_logs (references actor user, polymorphic entity)
report_jobs ──N:1── users
sync_batches ──1:N── sync_events
```

### Entity relationships (text)
- An **organization** has many **sites**, **vendors**, **users**, **workers**.
- A **site** has many **devices**, one effective **site_settings**, many **shifts**.
- A **worker** belongs to one org, one vendor (current), and is assigned to
  sites via **worker_site_assignments** (history-preserving for vendor changes /
  rehire / site transfer).
- An **attendance_session** belongs to worker + site + (optional) shift; built
  from one login **tap** and (usually) one logout **tap**.
- A **correction_request** targets a worker/day/session and contains items;
  approval mutates attendance and writes audit.

## 2. Enumerated Types

```sql
CREATE TYPE user_role        AS ENUM ('SUPER_ADMIN','SITE_ADMIN','WATCHMAN','SUPERVISOR');
CREATE TYPE worker_status    AS ENUM ('ACTIVE','INACTIVE','EXITED','SUSPENDED');
CREATE TYPE device_status    AS ENUM ('PENDING','AUTHORIZED','REVOKED');
CREATE TYPE session_state    AS ENUM ('OPEN','CLOSED','AUTO_CLOSED','VOID');
CREATE TYPE tap_type         AS ENUM ('LOGIN','LOGOUT');
CREATE TYPE tap_source       AS ENUM ('NFC_UID','NFC_NDEF','QR','MANUAL');
CREATE TYPE verification_mode    AS ENUM ('MANUAL','AUTO');
CREATE TYPE photo_verify_mode    AS ENUM ('ALWAYS','NEVER','RANDOM');
CREATE TYPE correction_type  AS ENUM ('LOGIN','LOGOUT','MISSING','WRONG_SITE');
CREATE TYPE correction_status AS ENUM ('PENDING','APPROVED','REJECTED','CANCELLED');
CREATE TYPE correction_reason AS ENUM ('FORGOT_CARD','DEVICE_ISSUE','NETWORK_ISSUE','WRONG_SITE','SUPERVISOR_MISTAKE','OTHER');
CREATE TYPE sync_event_status AS ENUM ('ACCEPTED','DUPLICATE','CONFLICT','REJECTED');
CREATE TYPE manual_approval_status AS ENUM ('PENDING','APPROVED','REJECTED');
```

## 3. Tables (DDL)

### 3.1 organizations
```sql
CREATE TABLE organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  code         TEXT NOT NULL UNIQUE,
  timezone     TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.2 sites
```sql
CREATE TABLE sites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  geofence_radius_m INTEGER,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
```

### 3.3 vendors
```sql
CREATE TABLE vendors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL,
  contact_person  TEXT,
  contact_number  TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
```

### 3.4 users (admins, supervisors, watchmen)
```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  role            user_role NOT NULL,
  full_name       TEXT NOT NULL,
  email           TEXT UNIQUE,
  phone           TEXT,
  password_hash   TEXT NOT NULL,          -- Argon2id
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Site scoping for SITE_ADMIN / WATCHMAN / SUPERVISOR (SUPER_ADMIN = all)
CREATE TABLE user_site_scopes (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id  UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);
```

### 3.5 devices
```sql
CREATE TABLE devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  site_id         UUID REFERENCES sites(id) ON DELETE SET NULL,
  device_uid      TEXT NOT NULL,          -- hardware/install id from app
  label           TEXT,
  platform        TEXT,                   -- android / ios
  status          device_status NOT NULL DEFAULT 'PENDING',
  token_hash      TEXT,                   -- hashed device token
  authorized_by   UUID REFERENCES users(id),
  authorized_at   TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, device_uid)
);
```

### 3.6 workers
```sql
CREATE TABLE workers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  worker_code        TEXT NOT NULL,                 -- human-facing Worker ID
  nfc_uid            TEXT,                           -- tag UID (nullable; QR-only allowed)
  qr_identifier      TEXT,                           -- opaque token, not PII
  full_name          TEXT NOT NULL,
  photo_url          TEXT,
  mobile_number      TEXT,
  blood_group        TEXT,
  emergency_contact_name   TEXT,
  emergency_contact_number TEXT,
  vendor_id          UUID REFERENCES vendors(id) ON DELETE SET NULL,
  pf_number          TEXT,
  esi_number         TEXT,
  aadhaar_ciphertext BYTEA,         -- AES-256-GCM (ciphertext+iv+tag)
  aadhaar_last4      TEXT,          -- for display/search only
  status             worker_status NOT NULL DEFAULT 'ACTIVE',
  join_date          DATE,
  exit_date          DATE,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,                    -- soft delete
  UNIQUE (organization_id, worker_code)
);

-- A UID/QR may be reissued over time (lost card). Enforce uniqueness only among
-- ACTIVE bindings via partial unique indexes (see §4).
```

### 3.7 worker_site_assignments (history-preserving)
```sql
CREATE TABLE worker_site_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  vendor_id   UUID REFERENCES vendors(id),
  start_date  DATE NOT NULL,
  end_date    DATE,                       -- NULL = current
  is_primary  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.8 credential bindings (audit of UID/QR over time)
```sql
CREATE TABLE worker_credentials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('NFC_UID','QR')),
  value       TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  reason      TEXT
);
```

### 3.9 shifts
```sql
CREATE TABLE shifts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  start_time    TIME NOT NULL,            -- site-local
  end_time      TIME NOT NULL,            -- if < start_time → overnight
  is_overnight  BOOLEAN NOT NULL DEFAULT FALSE,
  late_grace_minutes  INTEGER NOT NULL DEFAULT 0,
  early_grace_minutes INTEGER NOT NULL DEFAULT 0,
  ot_threshold_minutes INTEGER NOT NULL DEFAULT 0,  -- minutes beyond shift = OT
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.10 site_settings
```sql
CREATE TABLE site_settings (
  site_id                       UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  verification_mode             verification_mode NOT NULL DEFAULT 'MANUAL',
  auto_login_countdown_seconds  INTEGER NOT NULL DEFAULT 10,
  duplicate_tap_cooldown_seconds INTEGER NOT NULL DEFAULT 30,
  geo_enforcement               BOOLEAN NOT NULL DEFAULT FALSE,
  geo_radius_meters             INTEGER NOT NULL DEFAULT 200,
  photo_verification_mode       photo_verify_mode NOT NULL DEFAULT 'RANDOM',
  photo_verification_random_pct INTEGER NOT NULL DEFAULT 20
      CHECK (photo_verification_random_pct BETWEEN 0 AND 100),
  default_shift_id              UUID REFERENCES shifts(id),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.11 attendance_taps (raw events — immutable)
```sql
CREATE TABLE attendance_taps (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           UUID NOT NULL,        -- client-generated; idempotency key
  organization_id    UUID NOT NULL REFERENCES organizations(id),
  site_id            UUID NOT NULL REFERENCES sites(id),
  device_id          UUID REFERENCES devices(id),
  worker_id          UUID REFERENCES workers(id),     -- nullable if unresolved
  raw_identifier     TEXT,                  -- UID/QR/worker_code presented
  tap_source         tap_source NOT NULL,
  tap_type           tap_type,              -- decided by engine (LOGIN/LOGOUT)
  client_event_time  TIMESTAMPTZ NOT NULL,  -- device wall clock at tap
  server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  monotonic_ms       BIGINT,                -- device monotonic clock for tamper detect
  latitude           DOUBLE PRECISION,
  longitude          DOUBLE PRECISION,
  geo_accuracy_m     DOUBLE PRECISION,
  verified_mode      verification_mode,
  photo_captured_url TEXT,                  -- if photo verification triggered
  is_manual_backup   BOOLEAN NOT NULL DEFAULT FALSE,
  manual_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, event_id)        -- idempotency
);
```

### 3.12 attendance_sessions (derived login→logout)
```sql
CREATE TABLE attendance_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id),
  worker_id          UUID NOT NULL REFERENCES workers(id),
  site_id            UUID NOT NULL REFERENCES sites(id),
  shift_id           UUID REFERENCES shifts(id),
  work_date          DATE NOT NULL,         -- site-local business day
  login_tap_id       UUID REFERENCES attendance_taps(id),
  logout_tap_id      UUID REFERENCES attendance_taps(id),
  login_at           TIMESTAMPTZ NOT NULL,
  logout_at          TIMESTAMPTZ,
  state              session_state NOT NULL DEFAULT 'OPEN',
  worked_minutes     INTEGER,
  overtime_minutes   INTEGER,
  late_minutes       INTEGER,
  early_leave_minutes INTEGER,
  logout_site_id     UUID REFERENCES sites(id),  -- if logout at different site
  is_cross_site      BOOLEAN NOT NULL DEFAULT FALSE,
  closed_reason      TEXT,                  -- AUTO_CLOSED / CORRECTION / etc.
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.13 correction_requests + items
```sql
CREATE TABLE correction_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  worker_id       UUID NOT NULL REFERENCES workers(id),
  site_id         UUID NOT NULL REFERENCES sites(id),
  session_id      UUID REFERENCES attendance_sessions(id),
  work_date       DATE NOT NULL,
  type            correction_type NOT NULL,
  reason          correction_reason NOT NULL,
  notes           TEXT,
  requested_by    UUID NOT NULL REFERENCES users(id),
  status          correction_status NOT NULL DEFAULT 'PENDING',
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE correction_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     UUID NOT NULL REFERENCES correction_requests(id) ON DELETE CASCADE,
  field          TEXT NOT NULL,        -- e.g. login_at, logout_at, site_id
  proposed_value JSONB NOT NULL,
  previous_value JSONB
);
```

### 3.13a manual_attendance_requests

A punch a watchman typed in by hand rather than scanning a badge. The tap is
stored as usual, but no session moves until this row is APPROVED — so a PENDING
row means that person is *not* on the register, and *not* in the SOS headcount.

`session_id` means different things by direction, because the session exists at
different times: for a LOGOUT it is the open session the punch would close,
pinned when the request is filed; for a LOGIN it is filled in on approval with
the session that was created.

```sql
CREATE TABLE manual_attendance_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  site_id         UUID NOT NULL REFERENCES sites(id),
  worker_id       UUID NOT NULL REFERENCES workers(id),
  tap_id          UUID NOT NULL UNIQUE REFERENCES attendance_taps(id),
  tap_type        tap_type NOT NULL,
  session_id      UUID REFERENCES attendance_sessions(id),
  recorded_at     TIMESTAMPTZ NOT NULL,   -- when the watchman entered it
  reason          TEXT,                   -- the reason he typed at the gate
  device_id       UUID,
  status          manual_approval_status NOT NULL DEFAULT 'PENDING',
  reviewed_by     UUID,
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL
);
```

### 3.14 audit_logs (append-only, partitioned monthly)
```sql
CREATE TABLE audit_logs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID,
  actor_user_id UUID,
  actor_role    user_role,
  action        TEXT NOT NULL,        -- e.g. WORKER_UPDATE, CORRECTION_APPROVE
  entity_type   TEXT NOT NULL,
  entity_id     UUID,
  old_value     JSONB,
  new_value     JSONB,
  reason        TEXT,
  ip_address    INET,
  device_id     UUID,
  request_id    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
-- monthly partitions created by migration/cron; app role has INSERT+SELECT only.
```

### 3.15 sync_batches + sync_events
```sql
CREATE TABLE sync_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID NOT NULL REFERENCES devices(id),
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_count  INTEGER NOT NULL,
  accepted     INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  conflicts    INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     UUID NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
  event_id     UUID NOT NULL,
  status       sync_event_status NOT NULL,
  detail       TEXT,
  tap_id       UUID REFERENCES attendance_taps(id)
);
```

### 3.16 refresh_tokens
```sql
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    UUID NOT NULL,
  token_hash   TEXT NOT NULL,
  device_id    UUID REFERENCES devices(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.17 report_jobs
```sql
CREATE TABLE report_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  requested_by  UUID NOT NULL REFERENCES users(id),
  report_type   TEXT NOT NULL,        -- DAILY, MONTHLY, WORKER, VENDOR, SITE, OVERTIME, CORRECTION
  format        TEXT NOT NULL,        -- XLSX, CSV, PDF
  params        JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'QUEUED',  -- QUEUED, RUNNING, DONE, FAILED
  result_url    TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
```

## 4. Indexes & Constraints

```sql
-- Fast tap resolution (only one ACTIVE UID/QR per value within an org)
CREATE UNIQUE INDEX uq_worker_active_uid
  ON workers (organization_id, nfc_uid) WHERE nfc_uid IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_worker_active_qr
  ON workers (organization_id, qr_identifier) WHERE qr_identifier IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_credential_active
  ON worker_credentials (kind, value) WHERE is_active;

-- One OPEN session per worker (prevents double login) — enforced partial unique
CREATE UNIQUE INDEX uq_open_session_per_worker
  ON attendance_sessions (worker_id) WHERE state = 'OPEN';

-- One un-reviewed manual entry per worker. A second hand-typed punch for
-- someone already awaiting review is a mistake at the gate, not a queue.
CREATE UNIQUE INDEX uq_pending_manual_request_per_worker
  ON manual_attendance_requests (worker_id) WHERE status = 'PENDING';

-- Reporting / lookups
CREATE INDEX ix_sessions_worker_date  ON attendance_sessions (worker_id, work_date);
CREATE INDEX ix_sessions_site_date    ON attendance_sessions (site_id, work_date);
CREATE INDEX ix_taps_worker_time      ON attendance_taps (worker_id, client_event_time DESC);
CREATE INDEX ix_taps_site_time        ON attendance_taps (site_id, server_received_at DESC);
CREATE INDEX ix_corrections_status    ON correction_requests (status, organization_id);
CREATE INDEX ix_audit_entity          ON audit_logs (entity_type, entity_id);
CREATE INDEX ix_audit_actor_time      ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX ix_assign_worker_current ON worker_site_assignments (worker_id) WHERE end_date IS NULL;

-- Worker search (manual backup): trigram on name / code / mobile
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ix_workers_name_trgm ON workers USING gin (full_name gin_trgm_ops);
CREATE INDEX ix_workers_code      ON workers (organization_id, worker_code);
CREATE INDEX ix_workers_mobile    ON workers (organization_id, mobile_number);
```

**Key invariants enforced by DB:**
- Idempotency: `UNIQUE (organization_id, event_id)` on taps.
- No double-login: partial unique index `uq_open_session_per_worker`.
- One un-reviewed manual entry per worker: `uq_pending_manual_request_per_worker`.
- No double UID/QR among active workers.
- Referential integrity prevents deleting orgs/sites with dependents
  (`ON DELETE RESTRICT`); workers use **soft delete** (`deleted_at`).

## 5. Migrations Strategy
- Prisma Migrate (or TypeORM migrations). Each migration is forward-only in prod;
  destructive changes go through expand→migrate→contract.
- Seed migration creates: default org, a super-admin, enum-backed lookups,
  default site settings, default shift.
- A scheduled job pre-creates next month's `audit_logs` partition.

## 6. Data Retention & Privacy
- Aadhaar stored encrypted; decryption only via a dedicated service method with
  audit on every read.
- Soft-deleted workers retained for audit; PII can be scrubbed after legal
  retention window via a purge job (keeps attendance aggregates).
