# DairyFlow Backend API & Offline-First Sync Service

Fastify + MongoDB backend powering DairyFlow's multi-farm offline-first synchronization engine.

## Overview

- **Runtime**: Node.js 20+ (Docker image: Node 22), TypeScript
- **Framework**: Fastify 5
- **Database**: MongoDB (official `mongodb` driver)
- **Authentication**: email + password, email OTP verification, JWT (`@fastify/jwt`) with farm isolation
- **Security & Reliability**: `bcryptjs` hashing, per-IP rate limiting, per-account login throttling, `@fastify/helmet` headers, body size limits, request validation (`zod`), structured logs with request ids and secret redaction, monotonic sequence tracking with a commit watermark, tombstone delete propagation.

---

## Architecture & Data Model

### Collections

1. **`farms`**: Farm account profile (one farm per email address)
   - `_id`: ObjectId
   - `farmName`, `ownerName`: string
   - `email`: unique string (lower-cased); the login identifier
   - `emailVerified`: boolean (`false` until the registration OTP is confirmed)
   - `phone`: optional string (informational only)
   - `passwordHash`: bcrypt hash
   - `passwordChangedAt`: optional Date. Set on password reset/change; tokens issued before it are rejected.
   - `defaultMilkRate`: number
   - `createdAt`, `updatedAt`: Date

2. **`records`**: Generic synced store (one document per synced entity row)
   - `farmId`, `table`, `uuid`, `data`, `deleted` (tombstone), `seq` (per-farm monotonic), `updatedAt`, `clientUpdatedAt`
   - Indexes: unique `{ farmId, table, uuid }`, `{ farmId, seq }`

3. **`counters`**: Per-farm sequence allocator (`_id` = farmId)
   - `seq`: highest seq allocated; `committed`: commit watermark (all seqs `<= committed` are fully written); `lockId`/`lockUntil`: push lease

4. **`otps`**: pending one-time codes, one document per `{email, purpose}` (`purpose`: `register` | `reset`), unique index, TTL-purged.

5. **`login_attempts`**: per-email failed-login counters (`_id` = email), TTL-purged.

---

## Environment variables

Copy `.env.example` to `.env`. Invalid or missing required values make the server refuse to start, with a message listing every problem.

| Variable | Default | Required in production | Description |
|---|---|---|---|
| `NODE_ENV` | - | set to `production` | Enables the production checks below |
| `PORT` | `3000` | no | HTTP port |
| `MONGODB_URI` | `mongodb://localhost:27017` | yes (in practice) | Connection string |
| `MONGODB_DB` | `dairyflow` | no | Database name |
| `MONGODB_MAX_POOL_SIZE` | `20` | no | Driver pool size |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | no | Fail fast when MongoDB is unreachable |
| `JWT_SECRET` | dev-only built-in (loud warning) | **yes, >= 32 chars** | Signs JWTs and keys the OTP hashes |
| `CORS_ORIGIN` | `*` | **yes** (a list) | Comma-separated allowed origins. `*` is rejected in production... |
| `CORS_ALLOW_ANY_IN_PRODUCTION` | `false` | no | ...unless this is `true` |
| `TRUST_PROXY` | `false` | when behind a proxy | `true`, a hop count (`1`) or comma-separated proxy IPs/CIDRs. Needed so the per-IP rate limit sees the real client |
| `LOG_LEVEL` | `info` (`silent` in tests) | no | pino level |
| `SMTP_HOST` | empty | **yes** | Without it, dev prints codes to the console; production refuses to start |
| `SMTP_PORT` / `SMTP_SECURE` | `587` / `false` | no | `SMTP_SECURE=true` for implicit TLS (port 465) |
| `SMTP_USER` / `SMTP_PASS` | empty | depends on provider | |
| `SMTP_FROM` | `DairyFlow <no-reply@dairyflow.local>` | recommended | Sender address |
| `OTP_TTL_MINUTES` | `10` | no | Code validity (1-60) |

---

## Getting Started

### Local development

```bash
cd backend
docker compose up -d mongodb      # MongoDB only (or point MONGODB_URI at any MongoDB)
npm install
cp .env.example .env
npm run dev                       # hot reload; OTP codes are printed in the console
npm test                          # vitest + in-memory MongoDB (downloads a binary on first run)
npm run typecheck
npm run build && npm start
```

### Docker

```bash
cd backend
cp .env.example .env              # set JWT_SECRET, CORS_ORIGIN, SMTP_*  (production mode needs them)
docker compose up -d --build      # mongodb + api
curl http://localhost:3000/ready
```

- `docker compose up -d mongodb` starts only the database (host development, as before).
- The `api` service runs with `NODE_ENV=production`, so the production checks apply (strong `JWT_SECRET`, `SMTP_HOST`, explicit `CORS_ORIGIN`). It overrides `MONGODB_URI` to the compose `mongodb` service; remove that line from `docker-compose.yml` to use an external MongoDB (e.g. Atlas).
- The image is multi-stage (build, prod-deps, runtime), runs as the non-root `node` user, and has a `HEALTHCHECK` calling `/ready`.

---

## API Endpoints

Errors always have the shape `{ "error": { "code", "message", ...extra } }`. Every response carries an `x-request-id` header (an incoming `x-request-id` of 8-64 safe characters is reused).

### 1. Health
- `GET /health` -> `{ ok: true, time }`. Liveness, never touches the database, not rate limited.
- `GET /ready` -> `200 { ok: true, db: "up", time }`, or `503 { ok: false, db: "down" }` when MongoDB does not answer a ping within 2 s. Use for load-balancer / orchestrator readiness.

### 2. Authentication
Sign-up is two steps: register (an OTP is emailed), then verify the code. No token is issued until the email is confirmed.

- `POST /auth/register`
  - Body: `{ farmName, ownerName, email, password (min 8), phone?, defaultMilkRate? }`
  - `202 { status: "OTP_SENT", email, expiresInSeconds, resendAfterSeconds }`
  - `409 EMAIL_EXISTS` if a verified account already uses the email. Re-registering an *unverified* email replaces the pending details and sends a new code.
- `POST /auth/verify-otp`
  - Body: `{ email, otp }` (6 digits) -> `201 { token, farm }`
  - Errors: `400 OTP_INVALID` (with `attemptsLeft`), `400 OTP_EXPIRED`, `429 OTP_LOCKED` (5 wrong attempts; request a new code)
- `POST /auth/resend-otp`
  - Body: `{ email }` -> `202`. Always 202 for unknown/verified emails (no enumeration). `429 OTP_RESEND_COOLDOWN` within 60 s of the last code; `429 OTP_HOURLY_LIMIT` after 5 codes per hour.
- `POST /auth/login`
  - Body: `{ email, password }` -> `200 { token, farm }`
  - `401 INVALID_CREDENTIALS` (same for wrong password and unknown email); `403 EMAIL_NOT_VERIFIED` (the app then jumps to the OTP step)
  - `429 LOGIN_THROTTLED` with `Retry-After` after 10 failed attempts per email within 15 minutes (see Security).
- `POST /auth/forgot-password`
  - Body: `{ email }` -> **always** `202 { status: "OTP_SENT", email }`, whether or not the account exists. A code is emailed only for a verified account. The 60 s cooldown and 5/hour limits apply the same way as for register, but are enforced silently (still 202, no new email) so they cannot be used to probe accounts.
- `POST /auth/reset-password`
  - Body: `{ email, otp, newPassword (min 8) }` -> `200 { token, farm }` (signs the user in)
  - Errors identical to verify-otp: `400 OTP_INVALID` (+`attemptsLeft`), `400 OTP_EXPIRED`, `429 OTP_LOCKED`. An unknown email behaves exactly like a known one with a wrong code.
  - All previously issued tokens (other devices) stop working.
- `POST /auth/change-password` (Bearer)
  - Body: `{ currentPassword, newPassword (min 8) }` -> `200 { token }` (fresh token; use it from now on)
  - `401 INVALID_CREDENTIALS` if `currentPassword` is wrong (counts toward the login throttle); `400 PASSWORD_UNCHANGED` if the new password equals the current one; `400 VALIDATION_ERROR`.
  - All other tokens are invalidated.

OTP details: 6 digits from a CSPRNG, valid `OTP_TTL_MINUTES`, single use, stored only as an HMAC hash (purpose-bound), wrong attempts counted atomically. For `forgot-password` on an unknown or unverified email a decoy code (never emailed) is stored so every follow-up response is indistinguishable from the real case.

**Email delivery**: set `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) to send real emails. Without it the code is printed in the server log (`[DEV MAIL] ... for <email>: <code>`) for development; in production the server refuses to start without `SMTP_HOST`.

### 3. Farm Profile
- `GET /farm` (Bearer) -> `{ id, farmName, ownerName, email, phone, defaultMilkRate, createdAt, updatedAt }`
- `PATCH /farm` (Bearer), body `{ farmName?, ownerName?, defaultMilkRate? }` -> updated profile

### 4. Synchronization
- `POST /sync/push` (Bearer)
  - Body: `{ changes: Change[] }` (max 500 per batch, body up to 2 MB)
  - `Change`: `{ table, uuid, op: "upsert" | "delete", data?, clientUpdatedAt }`
  - Response: `{ applied, rejected: [{ uuid, table, reason }], cursor }`
  - `503 SYNC_BUSY` (with `Retry-After`) if another push for the same farm holds the lease for more than 20 s; retry.
- `GET /sync/pull?since=<seq>&limit=500` (Bearer)
  - `since` integer >= 0 (default 0), `limit` integer 1..500 (default 500); anything else is `400 VALIDATION_ERROR`.
  - Response: `{ changes: ServerChange[], cursor, hasMore }`; `ServerChange`: `{ table, uuid, op, data?, seq }`

#### Sync protocol and the cursor-race fix

Each change gets a per-farm monotonically increasing `seq`; clients pull with `since=<last cursor>`. A naive implementation allocates seqs and then writes rows, so a concurrent pull could see seq 2 (already written by push B) before seq 1 (allocated by push A, not yet written), advance its cursor to 2, and never see seq 1.

Fix (in `src/sync/service.ts`):

1. Pushes for one farm are **serialised** by a short Mongo lease on the farm's `counters` document (30 s lease, up to 20 s wait, then `503 SYNC_BUSY`). Conflict checks (last-write-wins on `clientUpdatedAt`), seq allocation and the write all happen under the lease.
2. `counters.committed` is a **commit watermark**, advanced to the batch's last seq only after the batch is fully written.
3. `pull` returns only rows with `since < seq <= committed`. A pull running during a push simply does not see that push's rows yet; they arrive on the next pull and are never skipped.
4. If a push fails mid-write the watermark is not advanced; the next successful push moves it past the gap (those seqs were already burnt), so rows are never hidden permanently. Counters created before the watermark existed are treated as fully committed.

Cursors only ever move forward and any seq at or below the cursor is guaranteed delivered.

---

## Security notes

- **Passwords**: bcrypt (cost 10); min 8 / max 128 chars. Unknown-email logins still run a bcrypt compare to equalise timing.
- **Session invalidation**: JWTs live 30 days. On password reset/change the farm gets `passwordChangedAt`; the auth plugin rejects any token whose `iat` is `<=` that second. This costs one indexed `_id` lookup per authenticated request and nothing is cached on purpose, so logout of other devices is immediate. (The token returned by the reset/change itself is issued with `iat` one second after, so it stays valid.) Accounts without the field are unaffected.
- **Login throttling**: 10 failed logins per email per 15 minutes -> `429 LOGIN_THROTTLED` + `Retry-After`; counted in MongoDB (works across instances), independent of the per-IP limiter, also applied to unknown emails (no enumeration) and to wrong `currentPassword` in `change-password`. Reset by a successful login/reset/change. Trade-off: an attacker who knows an email can lock that account out of password login for up to 15 minutes; password reset by email still works.
- **Per-IP rate limit**: 100 req/min globally, tighter on auth routes. Set `TRUST_PROXY` correctly behind a proxy, otherwise every client shares the proxy's IP. Never set `true` when the API is directly exposed (clients could spoof `X-Forwarded-For`).
- **Headers**: `@fastify/helmet` defaults (HSTS, nosniff, frame protection, CSP, ...).
- **Body limits**: 1 MB globally, 2 MB for `/sync/push` (`413` beyond).
- **CORS**: allow-list from `CORS_ORIGIN`; `*` refused in production unless `CORS_ALLOW_ANY_IN_PRODUCTION=true`.
- **Logging**: pino JSON logs with a request id on every line; `authorization`, cookies, request bodies and `password` / `newPassword` / `currentPassword` / `otp` / `token` fields are redacted. OTP codes are only printed by the development console mailer.
- **Process safety**: graceful shutdown on SIGINT/SIGTERM (10 s limit); `unhandledRejection` / `uncaughtException` are logged and trigger a clean exit (let the orchestrator restart the container).

---

## Deploying

1. Provision MongoDB (Atlas or self-hosted; 7.x tested) and an SMTP provider.
2. Set the production environment: `NODE_ENV=production`, `JWT_SECRET` (>= 32 random chars), `MONGODB_URI`, `CORS_ORIGIN`, `SMTP_*`, and `TRUST_PROXY` matching your proxy layout (e.g. `1` behind one load balancer).
3. Build and run the container (`docker build -t dairyflow-api .`, or `docker compose up -d --build`), or `npm ci && npm run build && npm start`.
4. Terminate TLS in front (the API sends HSTS). Point the load balancer health check at `GET /ready` (use `/health` for pure liveness).
5. Indexes are created automatically at startup. Run several instances if needed: pushes are serialised per farm in MongoDB, and login throttling and OTP limits live in MongoDB as well. Only the per-IP limiter is per instance (in memory).
6. Vercel: `api/index.ts` still exposes the same app as a serverless function (long-lived features such as graceful shutdown do not apply there).

---

## Pointing the Mobile App to the Backend

In `mobile/.env`:

- **Android Emulator**:
  ```env
  EXPO_PUBLIC_API_URL=http://10.0.2.2:3000
  ```
- **iOS Simulator / macOS**:
  ```env
  EXPO_PUBLIC_API_URL=http://localhost:3000
  ```
- **Physical Phone (Expo Go or Dev Client)**:
  Use your computer's local Wi-Fi IP address:
  ```env
  EXPO_PUBLIC_API_URL=http://192.168.1.XX:3000
  ```
