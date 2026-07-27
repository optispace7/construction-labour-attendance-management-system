# Phase 4 — Mobile Architecture (Flutter)

Flutter latest stable · Material 3 · Riverpod · Clean Architecture · offline-first.
Android first; iOS later from the **same codebase** (only NFC/QR platform glue differs).

## 1. Layered Clean Architecture

```
lib/
├── main.dart
├── app/                       # MaterialApp(M3), router (go_router), theme, DI root
├── core/
│   ├── error/                 # Failure types, Either<Failure,T>
│   ├── network/               # Dio client, auth interceptor, retry, connectivity
│   ├── storage/               # secure storage (tokens), Drift db (offline)
│   ├── time/                  # monotonic + wall clock, skew capture
│   ├── nfc/                   # NfcReader abstraction (NTAG213/215/216)
│   ├── qr/                    # QrScanner abstraction
│   ├── geo/                   # location service
│   └── config/                # env, feature flags
├── features/
│   ├── auth/         (data | domain | presentation)
│   ├── site_selection/
│   ├── attendance/            # tap → resolve → login/logout flow
│   ├── worker_card/           # info display, emergency mode
│   ├── supervisor/            # NFC scan → monthly summary
│   ├── corrections/           # request creation (supervisor)
│   └── sync/                  # outbox + sync engine
└── shared/                    # widgets, formatters
```

Each feature: **data** (DTOs, datasources remote+local, repository impl) →
**domain** (entities, repository interfaces, use cases) → **presentation**
(Riverpod providers/notifiers + widgets). Dependencies point inward only.

## 2. State Management (Riverpod)
- `riverpod` + `riverpod_generator` for compile-safe providers.
- Pattern: `AsyncNotifier` per screen; repositories exposed as providers; use
  cases are plain functions/classes injected via providers.
- Example providers: `siteSelectionProvider`, `attendanceTapProvider`,
  `outboxProvider`, `syncStatusProvider`, `connectivityProvider`.

## 3. Offline-First Design (the core)

### Local store (Drift / SQLite)
Mirrors server essentials so the app works fully offline:
- `local_taps` (outbox) — every tap written here first, with `eventId`, payload,
  `synced` flag, `attempts`, `lastError`.
- `local_sessions` — derived open/closed sessions for instant logout detection
  without a network round trip.
- `cached_workers` — id, code, uid, qr, name, photo path, blood group, emergency
  contact (the limited card data) for the active site. Refreshed when online.
- `cached_site_settings`, `cached_shifts`.
- `meta` — last sync cursor, active site, device token.

### Write path (durability first)
```
Tap detected
  → build event { eventId=uuid_v4(), clientEventTime, monotonicMs, geo, siteId, deviceId }
  → resolve worker LOCALLY from cached_workers (uid/qr/code)
  → decide LOGIN vs LOGOUT from local_sessions (open session exists?)
  → cooldown check against last local tap for this worker
  → WRITE to local_taps (outbox) + update local_sessions  [committed before any UI success]
  → show result to watchman
  → enqueue sync (fire-and-forget)
```
Because the write is committed to SQLite **before** the success screen,
attendance survives crash, restart, and network loss. Nothing is lost.

### Sync engine
- Background sync via `workmanager` (Android) + foreground triggers on
  connectivity regained / app resume.
- Batches unsynced `local_taps` → `POST /sync/attendance` with `Idempotency-Key`.
- On response, mark `ACCEPTED`/`DUPLICATE` as synced. `CONFLICT` and `REJECTED`
  are the server's **final word** (unresolvable identifier, expired card, an
  entry already awaiting review) — the error is recorded and the event then
  **leaves the outbox**. The server keeps its own record of what arrived, so
  nothing is lost by dropping the local copy.
- Exponential backoff with jitter; capped retries.

> **Why terminal events must not linger.** They used to stay pending forever, and
> the in/out decision skipped the server state refresh whenever *anything* was
> pending. One event the server would never accept therefore switched off that
> refresh for the life of the install: from then on the handset decided
> LOGIN/LOGOUT purely from its own history, so a worker a Super Admin had logged
> out in the admin panel went on being offered LOGOUT at the gate. The refresh
> now also checks only for punches belonging to *that worker* — another person's
> queue says nothing about them.

### Idempotency & dedupe
- `eventId` generated once at tap time and reused on every retry → server dedupes,
  so retries never create duplicates. This is what makes "tap during sync" safe.

### Conflict resolution strategy
| Situation | Local action | Server reconciliation |
|---|---|---|
| Login synced, logout offline | keep session open locally | logout event applied when synced |
| Logout before matching login arrives | queue logout; engine pairs by worker+day | if truly orphaned → `CONFLICT` → correction |
| Two devices, same worker same site | both send taps; server partial unique index keeps one OPEN session; 2nd login → `ALREADY_OPEN` resolved to logout-or-ignore | authoritative server decision returned |
| Clock skew/tamper | client sends monotonicMs + wall clock | server stores both; flags anomalies, uses server-anchored time for hours |
| Worker never logged out previous day | local + server auto-close prior session at shift end (configurable) | `AUTO_CLOSED` state, audited |

Server is the **source of truth**; the device reconciles to server results on each
sync and never overwrites server-confirmed sessions.

## 4. NFC Handling
- Abstraction `NfcReader` over `nfc_manager`. Reads **UID** always; attempts
  **NDEF** read for a stored Worker ID. Supports NTAG213/215/216.
- Tag handling:
  - **Locked tags** → read UID only (still resolvable).
  - **Empty tags** → fall back to UID.
  - **Unsupported / corrupt / damaged** → user-facing error + offer QR/manual.
  - **Unknown UID** (not in cache and offline) → store tap as `unresolved`
    against raw identifier; server resolves on sync, or watchman uses manual search.
- The tag stores only Worker ID **or** UID — never PII (enforced by never writing
  PII; the app only ever reads).

## 5. QR Backup
- `mobile_scanner` for QR. Same downstream flow as NFC (`source = QR`).
- Used when NFC unavailable/failed. Identical login/logout/cooldown logic.

## 6. Manual Backup (lost card)
- Watchman searches cached workers by code/name/mobile (local trigram-ish match;
  server search when online).
- Marking requires a **mandatory reason** → tap stored with `isManualBackup=true`,
  `manualReason`, and an **audit entry** is generated server-side on sync.

## 7. Verification Modes (client UX, server-authoritative)
- **MANUAL**: show worker card → watchman taps **CONFIRM LOGIN** → record.
- **AUTO**: show card → countdown (default 10s, from site settings) → auto record.
  Server already committed the login on tap in AUTO mode, so an interrupted
  countdown cannot lose attendance.
- **Photo verification** (`ALWAYS`/`NEVER`/`RANDOM` @ pct): when triggered, camera
  capture is attached to the tap (`photoUrl` after upload, or queued offline).

## 8. Geo Capture
- Every tap captures GPS (lat/lng/accuracy) when permitted. Stored locally and
  sent with the event. If site `geo_enforcement` on and outside radius, server
  returns `GEO_OUT_OF_RANGE`; client shows blocking message (configurable).

## 9. Emergency Mode
- From any worker card (even with limited permissions), an **Emergency** action
  shows blood group + emergency contact name/number with large, high-contrast UI
  and a one-tap call button. Backed by `/workers/{id}/emergency`, also cached
  offline for the active site.

## 10. Security on Device
- Tokens in `flutter_secure_storage` (Keystore/Keychain).
- Drift DB encrypted (SQLCipher) for cached PII (emergency/limited data).
- Certificate pinning optional for API.
- Device registration flow: app sends `deviceUid` → admin authorizes → app
  fetches device token; attendance disabled until `AUTHORIZED`.

## 11. Roles on Mobile
- **Watchman**: site selection, tap/verify/mark, limited worker view, emergency.
- **Supervisor**: scan worker → monthly summary view, create correction requests,
  add comments. Cannot edit attendance.

## 12. Testing (mobile)
- **Unit**: use cases, cooldown logic, login/logout decision, hours preview,
  conflict mapping. Mock repositories.
- **Widget**: tap flow screens, manual/auto verification, emergency screen.
- **Integration**: outbox→sync against a fake API; offline→online transition;
  crash/restart durability (kill mid-flow, ensure outbox intact).
- Target 80%+ coverage on domain + sync engine.
