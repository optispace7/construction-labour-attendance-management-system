# Phase 6 — Edge Cases & Resolution Strategy

Each row: scenario → detection → resolution → audit. "SoT" = server source of truth.

| # | Edge case | Detection | Resolution | Audit |
|---|---|---|---|---|
| 1 | **Worker taps twice** | Cooldown window (default 30s, site-config) checked locally + server | 2nd tap within window → `DUPLICATE_TAP`, ignored, no state change | tap logged, ignored flag |
| 2 | **Taps during sync** | Same `eventId` reused on retry | Server idempotency `UNIQUE(org,event_id)` → returns original (`IDEMPOTENT_REPLAY`) | single record only |
| 3 | **Login at site A, logout at site B** | Logout tap arrives with `siteId` ≠ session's `site_id` | Allowed: session closed, `logout_site_id` set, `is_cross_site=true`; hours credited to login site (configurable) | session updated, cross-site flag |
| 4 | **Worker already logged in** | Partial unique index `uq_open_session_per_worker` | New login → `ALREADY_OPEN`; treated per policy (ignore, or interpret as logout if past min duration) | conflict recorded |
| 5 | **Never logged out previous day** | Open session with `work_date < today` at shift-end | Scheduled job + on-next-tap: `AUTO_CLOSE` at shift end (config) before opening new session | `AUTO_CLOSED`, audited |
| 6 | **Worker assigned to different site** | Tap site ∉ worker's current assignment | Allowed but flagged `off_assignment=true`; admin report surfaces; optional block via policy | flagged |
| 7 | **Duplicate NFC UID** | Partial unique index on active UID per org | Cannot bind same active UID twice; binding a UID revokes prior active binding (lost-card reissue) via `worker_credentials` | credential change audited |
| 8 | **Corrupt / damaged tag** | NFC read error / CRC fail | Client shows error → fall back to QR or manual search | manual tap audited |
| 9 | **Empty tag** | No NDEF, UID present | Use UID; resolve via worker.nfc_uid | normal |
| 10 | **Unsupported tag** | Tech not NTAG21x | User-facing "unsupported tag"; QR/manual fallback | none (no tap) |
| 11 | **Offline attendance** | No connectivity | Write to local outbox first (durable), sync later; never lost | synced events audited |
| 12 | **Clock tampering** | `clientEventTime` vs `monotonicMs` vs `serverReceivedAt` skew | Store all three; large skew flagged; hours anchored to server-derived time; flagged events reviewable | tap flagged |
| 13 | **Multiple devices at same site** | Concurrent taps, distributed lock `worker:{id}:session` (Redis) + DB unique index | Only one OPEN session wins; others reconciled to server result on sync | conflict noted |
| 14 | **Supervisor correction conflicts** | Two pending corrections on same session/field | Approvals serialized; on approve, re-validate against current state; stale request → `CONFLICT`, requester re-submits | each decision audited |
| 15 | **Deleted worker records** | Soft delete (`deleted_at`) | Attendance retained; worker hidden from new taps; UID/QR freed from active uniqueness; reports still resolve historical name | delete audited |
| 16 | **Vendor changes** | New `worker_site_assignments` row with new `vendor_id`, old row `end_date` set | History preserved; reports attribute hours to vendor effective on each date | change audited |
| 17 | **Rehire** | `exit_date` set then `/rehire` creates new assignment, status→ACTIVE | Same worker record reused; new assignment period; prior history intact | rehire audited |
| 18 | **Daylight saving change** | Site IANA timezone | All stored UTC; shift/day boundaries computed via tz with DST awareness; overnight shifts use tz-aware date math | n/a |
| 19 | **Timezone issues** | Per-site timezone | Business day & shift computed in site-local tz; reports render site-local; storage UTC | n/a |
| 20 | **Network loss mid-flow** | Connectivity provider | UI success only after local commit; sync resumes on reconnect | synced later |
| 21 | **App crash / device restart** | App relaunch | Outbox persisted in SQLite; unsynced events re-sent on launch; open sessions restored from local_sessions | preserved |
| 22 | **Unknown UID while offline** | Not in cached_workers | Store `unresolved` tap vs raw identifier; server resolves on sync; or manual search | resolved/flagged |
| 23 | **Logout before login (sync order)** | Engine pairing by worker+day | Buffer logout; pair when login arrives; if orphaned → `CONFLICT` → correction | conflict |
| 24 | **Geo outside fence (enforced)** | Distance > radius | `GEO_OUT_OF_RANGE` (422); blocked or flagged per policy | tap rejected/flagged |
| 25 | **Photo verification offline** | Random/always triggers, no network | Capture stored locally, uploaded with sync; tap not blocked | photo linked on sync |
| 26 | **Manual backup misuse** | `isManualBackup` taps | Mandatory reason; the tap is stored but **no session is created or closed** — it files a `manual_attendance_requests` row that a Safety Officer / admin (`MANUAL_ATTENDANCE_REVIEW`) must accept before it becomes attendance. Declining leaves attendance untouched. Consequence: a pending entry is absent from "on site now" and the SOS headcount, and both apps say so | filed, then `MANUAL_ATTENDANCE_APPROVE` / `MANUAL_ATTENDANCE_REJECT` audited |
| 26a | **Second manual entry while one is pending** | Partial unique index `uq_pending_manual_request_per_worker` | `MANUAL_REVIEW_PENDING` (409) at the gate; nothing written | refusal returned, no tap |
| 26b | **Manual entry overtaken by a real scan** | Approval re-reads live state | Worker already OPEN (for a manual LOGIN) or already CLOSED (for a manual LOGOUT) → `CONFLICT` naming what happened; the reviewer declines the stale entry | audited on decline |
| 27 | **Refresh token reuse** | Rotation reuse detection | Revoke entire token family → forces re-login | security event audited |
| 28 | **Device revoked mid-shift** | Status check on each attendance call | `DEVICE_NOT_AUTHORIZED`; queued offline events from before still accepted by server if device was authorized at event time (policy) | events evaluated |
| 29 | **Duplicate event after partial server write** | `event_id` unique | Idempotent — original result returned | single record |
| 30 | **Overnight shift spanning midnight** | shift `is_overnight` / end<start | `work_date` = login's business day; hours computed across midnight in tz | n/a |
| 31 | **Worker exits with open session** | exit while OPEN | Auto-close session at exit effective time; block future taps | audited |
| 32 | **Concurrent correction + live tap** | Correction targets a session a new tap modifies | Approval transaction re-reads session; abort if changed → requester notified | audited |

## Cross-cutting guarantees
- **No attendance loss:** local-first durable write + idempotent server ingest.
- **No duplicates:** `event_id` uniqueness + cooldown + single-open-session index.
- **SoT is the server:** device reconciles to server results; never overwrites
  server-confirmed state.
- **Everything auditable:** every mutation (incl. auto-close, credential changes,
  approvals, sensitive reads) writes an audit record with old/new values.
