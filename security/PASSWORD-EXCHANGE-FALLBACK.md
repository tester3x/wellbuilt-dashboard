# Password-exchange fallback documentation (transitional)

## Purpose

When Gen2 Cloud Functions runtime SA lacked `iam.serviceAccounts.signBlob`,
`admin.auth().createCustomToken()` failed. Temporary fallback issued an
ID token via Identity Toolkit `signInWithPassword` after Admin set a random
password on a synthetic Firebase Auth user.

## How it worked

1. Ensure Auth user `driver_{driverIdNoDashes[:28]}` exists.
2. Ensure synthetic email `drv_{driverIdNoDashes[:28]}@drivers.wellbuilt-sync.local`.
3. Try `createCustomToken` → on signBlob failure:
4. Generate **ephemeral** password: `crypto.randomBytes(24).toString('base64url') + 'Aa1!'`
5. `admin.auth().updateUser(uid, { password: tempPassword })` — stored only as Auth’s
   irreversible password hash (Firebase Auth storage), **not** written to RTDB/Firestore/env.
6. POST Identity Toolkit `accounts:signInWithPassword` with email + temp password + public API key.
7. Return `idToken` + `refreshToken` to client (not the password).
8. Immediately rotate password to another random value (invalidate temp password).

## Persistence / logging audit

| Location | Password present? |
|----------|-------------------|
| Code memory (function instance) | Only during request |
| Firestore / RTDB / security_audit | **No** (audit stores `mintMethod` only) |
| Function env / secrets | **No** |
| Logs | **No** — password never logged; only message `using password-exchange fallback` |
| Client | Receives idToken/refreshToken only |

**No reusable plaintext or reversibly encoded password is persisted.**

## Shared by

- `authenticateDriver`
- `registerStandaloneDriver`
- (via `mintDriverSessionTokens` in `tokenMint.ts`)

## Production Auth users affected

Any disposable or legitimate secure-driver login that hit the fallback after
Option A deploy created/updated synthetic Auth users:

- UID pattern: `driver_*`
- Email pattern: `drv_*@drivers.wellbuilt-sync.local`

Known disposable sessions used password_exchange (e.g. Stage A prod verify).
Legitimate testers were **not** force-migrated; only users who authenticated
via secure callables while fallback was active.

## Invalidation after custom tokens work

1. Disable password-exchange by default (`ALLOW_PASSWORD_EXCHANGE_FALLBACK` not true).
2. Rotate passwords on synthetic accounts to random unusable values (or delete synthetic users).
3. Prefer `createCustomToken` only; clients use `signInWithCustomToken`.
