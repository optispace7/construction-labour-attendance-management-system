# Phase 3 — API Contracts

REST + OpenAPI 3.1. Base path `/api/v1`. JSON only. All errors use
**RFC 9457 problem+json**. All mutating endpoints accept an optional
`Idempotency-Key` header; attendance/sync endpoints require it.

## 1. Conventions

### Auth
- `Authorization: Bearer <access_jwt>` on all endpoints except `/auth/login`,
  `/auth/refresh`, `/health`.
- Attendance & sync endpoints additionally require `X-Device-Id` + device token;
  device must be `AUTHORIZED`.

### Error envelope (problem+json)
```json
{
  "type": "https://clams/errors/duplicate-tap",
  "title": "Duplicate tap ignored",
  "status": 409,
  "code": "DUPLICATE_TAP",
  "detail": "Worker tapped within the 30s cooldown window.",
  "instance": "/api/v1/attendance/tap",
  "requestId": "0f9c...",
  "meta": { "cooldownRemainingSeconds": 12 }
}
```

### Standard error codes
| HTTP | code | meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body/query failed validation (field list in `meta.errors`) |
| 401 | `UNAUTHENTICATED` | missing/expired token |
| 401 | `REFRESH_REUSE` | reused refresh token → family revoked |
| 403 | `FORBIDDEN` | RBAC/scope denied |
| 403 | `DEVICE_NOT_AUTHORIZED` | device pending/revoked |
| 404 | `NOT_FOUND` | entity missing |
| 404 | `WORKER_NOT_FOUND` | UID/QR/code unresolved |
| 409 | `DUPLICATE_TAP` | within cooldown |
| 409 | `MANUAL_REVIEW_PENDING` | a hand-typed punch for this worker is already awaiting review |
| 409 | `ALREADY_OPEN` | worker already has open session |
| 409 | `IDEMPOTENT_REPLAY` | returns original result (not an error to client) |
| 409 | `CONFLICT` | optimistic-lock/version mismatch |
| 422 | `GEO_OUT_OF_RANGE` | outside geofence when enforced |
| 422 | `BUSINESS_RULE` | other domain rule violation |
| 429 | `RATE_LIMITED` | too many requests |
| 500 | `INTERNAL` | unexpected |

### Pagination
Cursor-based: `?limit=50&cursor=<opaque>`; response `{ data:[], nextCursor }`.

## 2. Auth

```
POST /auth/login        { email, password }         → { accessToken, refreshToken, user }
POST /auth/refresh      { refreshToken }             → { accessToken, refreshToken }
POST /auth/logout       { refreshToken }             → 204
GET  /auth/me                                        → { user, permissions, scopes }
POST /auth/device/register { deviceUid, platform, label } → { deviceId, status:'PENDING' }
POST /auth/device/token    { deviceId }              → { deviceToken }   (after AUTHORIZED)
```

## 3. Master Data (RBAC-guarded)

```
# organizations  (SUPER_ADMIN)
GET    /organizations
POST   /organizations
GET    /organizations/{id}
PATCH  /organizations/{id}

# documents — site paperwork as PDFs (settings.manage), admin "Documents" page
GET    /company-documents?siteId=        # metadata only, soonest expiry first
POST   /company-documents                # { siteId, dataBase64, mimeType:'application/pdf', fileName, name?, validUntil?, remindDaysBefore? }
PATCH  /company-documents/{id}           # { siteId?, name?, validUntil?, remindDaysBefore? } — re-arms the reminder
DELETE /company-documents/{id}
GET    /company-documents/{id}/file      # streams the PDF (binary, not via the JSON proxy)
# siteId is required on upload and must belong to the caller's organization: a
# licence is granted for a particular project, so it expires against that
# project and the alert can name the site left uncovered. PATCH accepts a new
# siteId to move a document. Responses carry siteName alongside siteId.
# validUntil is a plain YYYY-MM-DD; the response adds daysUntilExpiry and
# remindOn, both computed in the organization's timezone. remindDaysBefore
# defaults to 10. DocumentExpiryMonitor mails the SUPER_ADMINs at that lead time
# and again on the day the document lapses.

# sites
GET    /sites?organizationId=&active=
POST   /sites
GET    /sites/{id}
PATCH  /sites/{id}
GET    /sites/{id}/settings
PUT    /sites/{id}/settings          # verification mode, countdown, cooldown, geo, photo policy
GET    /sites/{id}/shifts
POST   /sites/{id}/shifts
PATCH  /shifts/{id}

# vendors  (SUPER_ADMIN)
GET/POST /vendors ; GET/PATCH /vendors/{id}

# users (admins/supervisors/watchmen)
GET/POST /users ; GET/PATCH /users/{id}
PUT    /users/{id}/site-scopes  { siteIds:[] }

# devices
GET    /devices?siteId=&status=
PATCH  /devices/{id}            { status:'AUTHORIZED'|'REVOKED', siteId }
```

## 4. Workers

```
GET   /workers?siteId=&vendorId=&status=&q=&limit=&cursor=
POST  /workers                         # create profile
GET   /workers/{id}                    # full profile (RBAC: admin) — Aadhaar decrypted only with worker.viewSensitive
PATCH /workers/{id}
DELETE/workers/{id}                    # soft delete
POST  /workers/{id}/credentials        { kind:'NFC_UID'|'QR', value }   # bind, revokes previous active
POST  /workers/{id}/assign-site        { siteId, vendorId?, startDate }
POST  /workers/{id}/exit               { exitDate, reason }
POST  /workers/{id}/rehire             { joinDate, siteId, vendorId }

# Limited / lookup views
GET   /workers/lookup?uid=|qr=|code=   # returns limited card (id, name, photo, blood, emergency)
GET   /workers/search?q=               # manual backup search (name/code/mobile)
GET   /workers/{id}/emergency          # blood group + emergency contact — ALL roles
```

### Worker create — request contract
```json
{
  "workerCode": "W-00231",
  "fullName": "Ramesh Kumar",
  "mobileNumber": "+9198xxxxxxx",
  "bloodGroup": "B+",
  "emergencyContactName": "Sita",
  "emergencyContactNumber": "+9197xxxxxxx",
  "vendorId": "uuid",
  "siteId": "uuid",
  "pfNumber": "PF...",
  "esiNumber": "ESI...",
  "aadhaar": "xxxxxxxxxxxx",        // write-only; encrypted server-side; never returned
  "joinDate": "2026-06-01",
  "nfcUid": "04A1B2C3D4",           // optional
  "qrIdentifier": "opaque-token"    // optional
}
```
Validation: `workerCode` unique per org; `aadhaar` 12 digits if present;
`mobileNumber` E.164; at least one of `nfcUid`/`qrIdentifier` recommended.
Response never includes `aadhaar`; only `aadhaarLast4`.

## 5. Attendance (device-authorized)

### Tap (login OR logout — engine decides)
```
POST /attendance/tap        (Idempotency-Key required)
```
Request:
```json
{
  "eventId": "uuid-v4",            // client-generated; dedupe key
  "siteId": "uuid",
  "deviceId": "uuid",
  "source": "NFC_UID|NFC_NDEF|QR|MANUAL",
  "identifier": "04A1B2C3D4",      // UID / NDEF workerId / QR / workerCode
  "clientEventTime": "2026-06-09T08:01:22.000Z",
  "monotonicMs": 998877,
  "geo": { "lat": 12.97, "lng": 77.59, "accuracyM": 8.0 },
  "manual": { "isBackup": false, "reason": null },
  "photoUrl": null
}
```
Response (login):
```json
{
  "result": "LOGIN_RECORDED",
  "sessionId": "uuid",
  "worker": { "id":"uuid","fullName":"...","photoUrl":"...","bloodGroup":"B+",
              "emergencyContactName":"...","emergencyContactNumber":"..." },
  "verificationMode": "MANUAL",
  "requiresPhoto": false,
  "loginAt": "2026-06-09T08:01:22Z"
}
```
Response (logout): `{ "result":"LOGOUT_RECORDED", "sessionId", "workedMinutes", "overtimeMinutes", "logoutAt" }`

Possible non-2xx: `DUPLICATE_TAP` (cooldown, includes remaining seconds),
`WORKER_NOT_FOUND`, `GEO_OUT_OF_RANGE`, `DEVICE_NOT_AUTHORIZED`,
`IDEMPOTENT_REPLAY` (returns original payload, treated as success by client).

> In **MANUAL** mode the tap returns the worker card and `requiresConfirm:true`;
> the client then calls `POST /attendance/confirm { sessionId|eventId }`.
> In **AUTO** mode the login is recorded immediately (client runs the countdown
> UI only; the server already committed, so a missed countdown never loses data).

**Manual (typed) entries.** `manual.isBackup: true` — a watchman entering a
worker code by hand instead of scanning — never records attendance directly.
Whatever the site's verification mode, the response is:
```json
{ "result": "MANUAL_PENDING_APPROVAL", "requestId": "uuid", "tapType": "LOGIN",
  "worker": { ... }, "recordedAt": "2026-06-09T08:01:22Z" }
```
The tap is persisted, but no session is created or closed until the request is
accepted (§7a). `POST /attendance/confirm` refuses these — confirming is the
watchman saying the face matches the badge, not an approval. Duplicate cooldown,
safety gap and card expiry still refuse a manual entry exactly as they do a scan.

```
POST /attendance/confirm     { eventId }                  → finalizes manual login
GET  /attendance/active?siteId=                            → currently open sessions at site
GET  /attendance/worker/{workerId}/summary?month=YYYY-MM   → supervisor view payload
```

### Supervisor scan payload (`/attendance/worker/{id}/summary`)
```json
{
  "worker": { "id", "fullName", "photoUrl" },
  "month": "2026-06",
  "totalMonthlyMinutes": 10260,
  "overtimeMinutes": 720,
  "absentDays": 2,
  "lateArrivals": 3,
  "daily": [
    { "date":"2026-06-01","loginAt":"08:02","logoutAt":"17:31",
      "workedMinutes":569,"overtimeMinutes":0,"late":true,"earlyLeave":false }
  ]
}
```

## 6. Sync (offline batch ingest)

```
POST /sync/attendance        (Idempotency-Key required)
```
Request: `{ "deviceId":"uuid", "events": [ <tap payload>, ... ] }` (≤ N per batch)

Response:
```json
{
  "batchId": "uuid",
  "summary": { "accepted": 18, "duplicates": 3, "conflicts": 1, "rejected": 0 },
  "results": [
    { "eventId":"...", "status":"ACCEPTED", "tapId":"..." },
    { "eventId":"...", "status":"DUPLICATE" },
    { "eventId":"...", "status":"CONFLICT", "detail":"logout before login; queued for review" }
  ]
}
```
The client marks locally-stored events synced by `eventId` based on results;
`CONFLICT` items are surfaced and (if needed) become correction requests.

## 7. Corrections

```
POST  /corrections                # supervisor/site-admin create request
GET   /corrections?status=&siteId=&workerId=&autoApplied=true
GET   /corrections/{id}
POST  /corrections/{id}/approve   { reviewNotes }   # admin only → applies + audits
POST  /corrections/{id}/reject    { reviewNotes }
POST  /corrections/{id}/cancel    # requester
```
Create request:
```json
{
  "workerId":"uuid", "siteId":"uuid", "workDate":"2026-06-08",
  "type":"LOGOUT", "reason":"FORGOT_CARD", "notes":"left at 17:30 per supervisor",
  "items":[ { "field":"logout_at", "proposedValue":"2026-06-08T12:00:00Z" } ]
}
```
`items` may carry **both ends of a session at once** — the mobile and web forms
both offer the pair, so a day that was never scanned is fixed in one request:
```json
{
  "workerId":"uuid", "siteId":"uuid", "workDate":"2026-08-08",
  "type":"MISSING", "reason":"DEVICE_ISSUE", "notes":"gate tablet was dead all night",
  "items":[
    { "field":"login_at",  "proposedValue":"2026-08-08T16:00:00Z" },
    { "field":"logout_at", "proposedValue":"2026-08-09T02:30:00Z" }
  ]
}
```
Note the second instant is the *following* morning: that is a night shift
(21:30 → 08:00 IST). The clients date the logout a day on when the out time is
at or before the in time. The session is filed under the day they came in —
`workDate` is derived from `login_at`, never from the logout — and a pair whose
logout is not after its login is refused rather than saved as a zero-hour day.
**Invariant:** one apply path, always. `CorrectionsService.applyInTx` is the
only code that mutates attendance from a correction, and it runs in a
transaction: update session → recompute hours → write audit (old/new) → mark
request APPROVED.

**Direct apply.** A user carrying `canApplyCorrections` (granted per person by
the SUPER_ADMIN on the Users page — see `UsersService.assertCanGrantDirectApply`)
has their own corrections applied by `POST /corrections` in the same transaction
that files them, instead of queueing. The response comes back `status:APPROVED`
with `autoApplied:true`, which is how the web and mobile forms know to say
"applied" rather than "sent for approval". The bypass is audited as
`CORRECTION_AUTO_APPLY` rather than `CORRECTION_APPROVE`, and the flagged rows
are listed for the Super Admin at `GET /corrections?autoApplied=true`. Everyone
else is unchanged: the request lands PENDING and attendance moves only on
approval. The grant is read from the user row per request, so revoking it takes
effect immediately rather than at the next token refresh.

## 7a. Manual attendance approvals

```
GET   /manual-approvals?status=PENDING|APPROVED|REJECTED&siteId=
GET   /manual-approvals/pending-count                      → { "pending": 3 }
POST  /manual-approvals/{id}/approve  { reviewNotes }      → creates/closes the session
POST  /manual-approvals/{id}/reject   { reviewNotes }      → attendance unchanged
```
All four sit on `MANUAL_ATTENDANCE_REVIEW` — held by Safety Officer, Admin and
Super Admin, and deliberately **not** by the watchman who files them. Not
device-gated: reviewing is a decision, not a scan. Non–Super Admins see only
their site scopes.

**Invariant:** accepting is the *only* path that turns a typed entry into
attendance. A `LOGIN` materialises a session at `recordedAt` (the moment the
watchman entered it, not the review time); a `LOGOUT` closes the session pinned
when the request was filed, and scores the hours. Declining writes nothing —
the tap stays as evidence, and the row records who declined it and why.

Approval re-reads live state and refuses (`CONFLICT`) if the world moved on:
the worker already has an open session (for a `LOGIN`), or the pinned session
was already closed by a real scan (for a `LOGOUT`). The reviewer declines the
stale entry instead.

**Consequence to design around:** while a request is `PENDING`, that person is
absent from `/attendance/active`, from the dashboard headcount, and from the SOS
roster. Both clients surface the pending count prominently for this reason.

## 8. Reports

```
POST /reports        { reportType, format, params }   → { jobId, status:'QUEUED' }
GET  /reports/{jobId}                                  → { status, resultUrl? }
GET  /reports?type=&from=&to=                          # list
```
`reportType ∈ {DAILY, MONTHLY, WORKER, VENDOR, SITE, OVERTIME, CORRECTION}`,
`format ∈ {XLSX, CSV, PDF}`. Generation is async (BullMQ); result stored in
object store, `resultUrl` is a signed, expiring link.

## 9. Audit

```
GET /audit?entityType=&entityId=&actorUserId=&from=&to=&action=
```
Read-only, admin-scoped; returns paginated immutable records with old/new JSON.

## 10. Validation Rules (representative)
- DTO validation via `class-validator`; reject unknown fields (`whitelist`,
  `forbidNonWhitelisted`).
- `clientEventTime` must be within a sane skew window (e.g. ±24h of server);
  large skew flagged as possible clock tampering (accepted but marked).
- `geo` required when site `geo_enforcement = true`; distance ≤ radius else 422.
- `correction.proposedValue` validated against field type; `logout_at > login_at`.
- All list endpoints enforce org/site scope from the caller's token.

## 11. OpenAPI
Generated from NestJS decorators (`@nestjs/swagger`) → `openapi.json` served at
`/api/docs` and committed to the repo for client codegen (mobile + admin).
