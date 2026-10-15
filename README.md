# DairyFlow Backend API & Offline-First Sync Service

Fastify + MongoDB backend powering DairyFlow's multi-farm offline-first synchronization engine.

## Overview

- **Runtime**: Node.js 20+, TypeScript
- **Framework**: Fastify 5
- **Database**: MongoDB (official `mongodb` driver)
- **Authentication**: JWT (`@fastify/jwt`) with farm isolation
- **Security & Reliability**: `bcryptjs` password hashing, rate limiting, request validation (`zod`), monotonic sequence tracking (`counters`), and tombstone delete propagation.

---

## Architecture & Data Model

### Collections

1. **`farms`**: Farm account profile (one farm per email address)
   - `_id`: ObjectId
   - `farmName`: string
   - `ownerName`: string
   - `email`: unique string (lower-cased); the login identifier
   - `emailVerified`: boolean (`false` until the registration OTP is confirmed)
   - `phone`: optional string (informational only)
   - `passwordHash`: bcrypt hash
   - `defaultMilkRate`: number
   - `createdAt`, `updatedAt`: Date

2. **`records`**: Generic synced store (one document per synced entity row)
   - `_id`: ObjectId
   - `farmId`: string (from JWT token)
   - `table`: string (`buyers`, `milk_entries`, `expenses`, `buyer_payments`, `livestock`, `livestock_activities`, `settings`)
   - `uuid`: string (client-generated UUID v4 / 32-hex global identifier)
   - `data`: document contents (object; empty when deleted)
   - `deleted`: boolean tombstone flag
   - `seq`: number (per-farm monotonic incrementing sequence number)
   - `updatedAt`: Date
   - `clientUpdatedAt`: ISO timestamp string
   - Indexes: unique `{ farmId: 1, table: 1, uuid: 1 }`, `{ farmId: 1, seq: 1 }`

3. **`counters`**: Monotonic sequence allocator
   - `_id`: farmId
   - `seq`: atomic counter incremented per batch during push

---

## Environment Variables

Copy `.env.example` to `.env`:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=dairyflow
JWT_SECRET=your_super_secret_jwt_key_at_least_32_characters
CORS_ORIGIN=*
```

---

## Getting Started

### Local MongoDB via Docker

```bash
cd backend
docker compose up -d
```

### Installation & Scripts

```bash
cd backend
npm install

# Start development server with hot-reload
npm run dev

# Run test suite with in-memory MongoDB
npm test

# Check TypeScript types
npm run typecheck

# Production build
npm run build
npm start
```

---

## API Endpoints

### 1. Health
- `GET /health` -> `{ ok: true, time: ISOString }`

### 2. Authentication
Sign-up is two steps: register (an OTP is emailed), then verify the code. No token is issued until the email is confirmed.

- `POST /auth/register`
  - Body: `{ farmName, ownerName, email, password (min 8), phone?, defaultMilkRate? }`
  - Response: `202 { status: "OTP_SENT", email, expiresInSeconds, resendAfterSeconds }`
  - `409 EMAIL_EXISTS` if a verified account already uses the email. Re-registering an *unverified* email replaces the pending details and sends a new code.
- `POST /auth/verify-otp`
  - Body: `{ email, otp }` (6 digits)
  - Response: `201 { token, farm }`
  - Errors: `400 OTP_INVALID` (with `attemptsLeft`), `400 OTP_EXPIRED`, `429 OTP_LOCKED` (5 wrong attempts; request a new code)
- `POST /auth/resend-otp`
  - Body: `{ email }`
  - Response: `202`. Always 202 for unknown/verified emails (no account enumeration). `429 OTP_RESEND_COOLDOWN` within 60 s of the last code; `429 OTP_HOURLY_LIMIT` after 5 codes per hour.
- `POST /auth/login`
  - Body: `{ email, password }`
  - Response: `200 { token, farm }`; `401 INVALID_CREDENTIALS` (same message for wrong password and unknown email); `403 EMAIL_NOT_VERIFIED` (the app then jumps to the OTP step).

OTP details: 6 digits from a CSPRNG, valid `OTP_TTL_MINUTES` (default 10), single use, stored only as an HMAC hash, wrong attempts counted atomically.

**Email delivery**: set `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) to send real emails. Without `SMTP_HOST` the code is printed in the server log (`[DEV MAIL] OTP for …`) for local development; in production (`NODE_ENV=production`) sending fails instead, so a missing SMTP config is never silent.

### 3. Farm Profile
- `GET /farm` (Bearer Token) -> `{ id, farmName, ownerName, email, phone, defaultMilkRate, createdAt, updatedAt }`
- `PATCH /farm` (Bearer Token)
  - Body: `{ farmName?, ownerName?, defaultMilkRate? }`
  - Response: Updated farm profile

### 4. Synchronization
- `POST /sync/push` (Bearer Token)
  - Body: `{ changes: Change[] }` (maximum 500 items per batch)
  - `Change`: `{ table, uuid, op: "upsert" | "delete", data?, clientUpdatedAt }`
  - Response: `{ applied: number, rejected: Array<{ uuid, table, reason }>, cursor: number }`
- `GET /sync/pull?since=<seq>&limit=500` (Bearer Token)
  - Response: `{ changes: ServerChange[], cursor: number, hasMore: boolean }`
  - `ServerChange`: `{ table, uuid, op: "upsert" | "delete", data?, seq }`

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
