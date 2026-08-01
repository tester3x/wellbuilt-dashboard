# Phase 2 — Secure Identity & Server Boundaries

## Goals

1. Eliminate anonymous RTDB/Firestore/Storage access.
2. Registration, login, approval enforced **only** on trusted server (Cloud Functions Admin SDK).
3. Clients never write `drivers/approved` or credential material.
4. Passcodes stored with **scrypt** (salted, slow); never as public SHA-256 RTDB keys.
5. Authenticated access uses **Firebase Auth custom tokens** with claims: `driverId`, `companyId`, `roles[]`, `kind: 'driver'`.
6. Dashboard continues email/password Auth + `users/{uid}` roles.

## Data model (secured)

### Firestore (client deny-all; Admin SDK only)

```
driver_credentials/{driverId}
  displayNameNorm: string
  displayName: string
  passcode: { algo: 'scrypt', saltB64, hashB64, N, r, p, keyLen }
  legacySha256: string | null   // never used for login after cutover; optional audit only
  mustResetPasscode: boolean
  active: boolean
  createdAt, updatedAt: server timestamps
  pendingId?: string

driver_name_index/{displayNameNorm}
  driverId: string

security_audit/{autoId}
  action, actorUid, driverId, appId, appCheckPresent, ipHash, ts, detail
```

### RTDB (profile + pending; credentials never here)

```
drivers/profiles/{driverId}     // public-to-auth fields only
  displayName, legalName, companyId, companyName, active, isAdmin, isViewer,
  assignedCustomers, assignedRoutes, roles, approvedAt, registrationCompany, ...

drivers/pending_secure/{pendingId}
  displayName, legalName, companyName, source, status, requestedAt (server),
  appId, schemaVersion
  // passcode material ONLY in Firestore driver_credentials or pending_credentials

// LEGACY (transition only — rules will deny client access at enforcement):
drivers/approved/{legacyHash}
drivers/pending/{pushId}
```

### Auth custom claims (driver sessions)

```json
{
  "kind": "driver",
  "driverId": "uuid",
  "companyId": "liquidgold" | null,
  "roles": ["driver"]
}
```

Dashboard users keep email Auth; claims optional later. Role source of truth remains `users/{uid}` until claims backfill.

## Callables

| Callable | Auth | App Check (target) | Purpose |
|----------|------|--------------------|---------|
| `requestDriverRegistration` | none | enforce when clients ship | Create pending + scrypt credential pending |
| `checkDriverRegistrationStatus` | none + pendingId secret | optional | Status poll without public hash dump |
| `authenticateDriver` | none | enforce when clients ship | Verify scrypt → custom token |
| `adminListPendingRegistrations` | dashboard + manageDrivers | — | Admin list |
| `adminApproveDriverRegistration` | dashboard + manageDrivers | — | Approve; create profile; mint driverId |
| `adminRejectDriverRegistration` | dashboard + manageDrivers | — | Reject only (no delete of suspicious evidence) |
| `adminSetDriverPasscode` | dashboard + manageDrivers | — | Force reset / first credential for legacy migrate |
| `registerStandaloneDriver` | none | enforce | **Server-side** free-tier only; replaces JSA client self-approve |
| `driverSignalLogout` | driver Auth | — | Clear session markers |
| `driverUpdateProfile` | driver Auth | — | Self profile fields only |

## Approval rules

- Clients **cannot** write profiles or credentials.
- Admin approval requires Firebase Auth + RTDB `users/{uid}` with `manageDrivers` (same pattern as `inviteEmployee`).
- Company-scoped admins may only approve into their `companyId`.
- Free-tier standalone: **server** may auto-create active free profile; never from client SDK/REST.

## Rate limits

RTDB `security/rate_limit/{bucket}/{key}` via Admin SDK:

- Registration: 5 / hour / IP hash
- Login: 10 / 15 min / displayNameNorm + IP hash
- Standalone: 3 / hour / IP hash

## CAPTCHA

Dashboard web `/register` (email signup): add reCAPTCHA in a later web-only commit. Mobile callables rely on App Check + rate limits first.

## App Check

Callables accept `enforceAppCheck: true` behind config flag `SECURITY_ENFORCE_APPCHECK` (false until all apps register App Check providers). Checkpoint deploys functions with flag **false** for dual-run; flip true before rule enforcement.

## Rules enforcement (later stage)

See `database.rules.secure.json`, `firestore.rules.secure`, `storage.rules.secure`.

- Default deny.
- Driver Auth: read own `drivers/profiles/{driverId}` where `auth.token.driverId == driverId`.
- Dashboard Auth: role helpers for admin paths.
- Packets/invoices: phase 2b — initially **callable-only** ingest where possible; transitional rules require Auth.

## Explicit removals

- JSA `registerStandalone` client PATCH to `drivers/approved` → call `registerStandaloneDriver`.
- All `firebasePost('drivers/pending')` → `requestDriverRegistration`.
- All client login hash lookups → `authenticateDriver` + `signInWithCustomToken`.
- Dashboard direct `set(drivers/approved/...)` for approve → `adminApproveDriverRegistration`.

## Rollback (availability without reopening anonymous)

1. Redeploy previous **functions** revision (callables).
2. Keep **secure rules** in place (do not restore `.read/.write true`).
3. If clients break: temporarily allow **authenticated** broader reads only — never anonymous.
4. Evidence backup path is source of truth for data restore via Admin SDK scripts, not open rules.
