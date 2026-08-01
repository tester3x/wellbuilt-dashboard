# Phase 4 — Rules adversarial test plan

Run against the **Firebase emulator** with `database.rules.secure.json`, `firestore.rules.secure`, and `storage.rules.secure` **before** production enforcement.

## Cases

| # | Case | Expected |
|---|------|----------|
| 1 | Anonymous RTDB root shallow read | Permission denied |
| 2 | Anonymous RTDB `drivers/approved` read | Permission denied |
| 3 | Anonymous RTDB `drivers/pending` write | Permission denied |
| 4 | Anonymous RTDB `drivers/approved/{any}` write (self-approve) | Permission denied |
| 5 | Anonymous Firestore `invoices` write | Permission denied |
| 6 | Anonymous Storage `photos/...` write | Permission denied |
| 7 | Valid `requestDriverRegistration` callable | Creates pending_secure + pending_credentials |
| 8 | Oversized displayName / short passcode | invalid-argument |
| 9 | Rate limit register >5/hour same IP hash | resource-exhausted |
| 10 | Pending applicant cannot write profiles | denied |
| 11 | Driver Auth cannot write `drivers/approved` | denied |
| 12 | Driver Auth cannot set isAdmin on profile | write denied (Admin SDK only) |
| 13 | Driver A cannot read Driver B profile | denied |
| 14 | Cross-company manager cannot approve into other company | permission-denied |
| 15 | Legacy public SHA key login path | fails (no credential; hash not Auth) |
| 16 | Admin without manageDrivers cannot approve | permission-denied |
| 17 | App Check enforce flag on → missing token | failed-precondition |
| 18 | Rejected pending cannot authenticate | no name index / no creds |
| 19 | Suspicious legacy pendings remain readable to admin only | preserved, status rejected |
| 20 | JSA cannot client-write approved | denied |
| 21 | Cloud Functions Admin SDK still processes packets | success |
| 22 | Legitimate migrated driver authenticates after adminSetDriverPasscode | custom token |

## Automated unit (repo)

```bash
cd Dashboard/functions && npm run build
node lib/security/passcode.unit.test.js
```

## Production probes (post-enforcement only)

```
GET https://wellbuilt-sync-default-rtdb.firebaseio.com/.json?shallow=true
→ expect 401/Permission denied
```

Do **not** run write probes against production.
