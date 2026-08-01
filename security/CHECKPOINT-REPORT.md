# CHECKPOINT — WellBuilt Database Security Containment

**Status: STOP before production deploy of rules/functions.**
Await Mike review and explicit authorization.

**Branch (Dashboard):** `security/database-containment`
**Evidence backup:** `D:\dev\_forensic_backups\wellbuilt-sync-security-20260731-201322`
**Date:** 2026-07-31

---

## 1. Lead answers (current state — pre-deploy)

| Question | Answer |
|----------|--------|
| 1. Anonymous access closed? | **No — not yet.** Production still open. Secure rule files are **draft only** (`*.secure`). |
| 2. Legitimate users still work? | **Yes** — production unchanged until deploy. |
| 3. Who needs re-register / updates? | **All drivers** need **new passcodes** after secure auth goes live; **all field apps** need new builds. Dashboard email Auth users unchanged. |
| 4. Unauthorized modification found? | **Two unauthorized pending registrations** confirmed. **No confirmed** unauthorized approvals or data deletes (logs unavailable). |
| 5. Deployed commits/rules/functions? | **Nothing production-deployed** from this work. |
| 6. Verification results | Functions **tsc build OK**; passcode unit tests **pass** (incl. legacy 4-digit offline crack demo). Emulator adversarial suite **documented, not yet run against emulator**. |
| 7. Remaining unresolved exposure | Full RTDB/Firestore/Storage still world-open until enforcement. |

---

## 2. Dependency inventory

See `security/PHASE1-INVENTORY.md` and session exploration report.

Critical paths: `drivers/*`, packets, well_config, users, Firestore invoices/tickets/dispatches/jsas/chat, Storage photos/jsa/ewallet — almost all clients use **direct** access today.

---

## 3. Identity architecture

See `security/IDENTITY-ARCHITECTURE.md`.

- **scrypt** passcodes in Firestore `driver_credentials` (client deny-all)
- Callables for register / login / approve / reject / set passcode / standalone
- Custom tokens with `kind=driver`, `driverId`, `companyId`, `roles`
- **JSA self-approve removed** from client (server `registerStandaloneDriver` only)
- Legacy SHA-256 **not** accepted for secure login; force new passcodes

---

## 4. Repositories / files changed (this stack)

### Dashboard (`security/database-containment`)
- `functions/src/security/**` — callables + scrypt + rate limit + audit + admin auth
- `functions/src/index.ts` — exports
- `database.rules.secure.json`, `firestore.rules.secure`, `storage.rules.secure`
- `security/*.md` — inventory, architecture, migration, tests, checkpoint
- `src/lib/secureDriverAdmin.ts`
- `src/components/admin/DriversTab.tsx` — reject via secure callable when available

### Suite
- `src/core/services/secureDriverAuth.ts`
- `src/core/services/driverAuth.ts` — secure-first dual-run

### WB-T
- `utils/secureDriverAuth.ts`
- `utils/driverAuth.ts` — secure-first dual-run

### JSA
- `services/driverAuth.ts` — **removed client self-approve**

### eWallet
- `services/secureDriverAuth.ts`
- `services/driverAuth.ts` — secure-first dual-run

**Not fully wired yet (still need same dual-run before enforcement):** WB-M, WB-M-delivery, WB-T-Metro, wellbuilt-ewallet (mirror WB-T/eWallet patches).

---

## 5. Migration matrix

See `security/MIGRATION-MATRIX.md`.

| Who | Action before rule enforcement |
|-----|--------------------------------|
| Mike (all devices) | Install updated Suite, WB-T, JSA, eWallet, WB-M; **new passcodes** via Admin `adminSetDriverPasscode` or re-register |
| Liquid Gold testers (Marcial, AdanS, Wisho-135, etc.) | Updated apps + **new passcodes** |
| AcmeMike | Same |
| Dashboard admins (email) | Redeploy Admin; no passcode reset |
| Suspicious pendings | **Reject only** (already backed up); **do not delete** |

---

## 6. Proposed production deploy order (when Mike authorizes)

1. `firebase deploy --only functions:requestDriverRegistration,functions:checkDriverRegistrationStatus,functions:authenticateDriver,functions:adminListPendingRegistrations,functions:adminApproveDriverRegistration,functions:adminRejectDriverRegistration,functions:adminSetDriverPasscode,functions:registerStandaloneDriver,functions:adminComputeLegacyHash`
   *(or full functions deploy if preferred)*
2. **Do not deploy secure rules yet.**
3. Distribute app builds; migrate each approved driver with `adminSetDriverPasscode` (include `legacyHash` to copy profile + disable legacy active).
4. Verify Mike login on Suite + WB-T + admin approve path.
5. Deploy secure rules:
   - copy `database.rules.secure.json` → `database.rules.json`
   - `firestore.rules.secure` → `firestore.rules`
   - `storage.rules.secure` → `storage.rules`
   - `firebase deploy --only database,firestore:rules,storage`
6. Probe: unauth RTDB GET must fail.
7. Monitor function logs / `security_audit`.

---

## 7. Emulator / unit results

| Test | Result |
|------|--------|
| `npm run build` (functions) | **PASS** |
| `node lib/security/passcode.unit.test.js` | **PASS** (scrypt round-trip; legacy 4-digit space crackable) |
| Rules emulator adversarial suite | **Not run** — plan in `security/rules-adversarial-tests.md` |
| Production anonymous probe after rules | **Blocked until Mike authorizes** |

---

## 8. Rollback (without reopening anonymous)

1. Redeploy previous functions revision.
2. **Keep secure rules** if already enforced.
3. If need temporary data access for Admin SDK scripts only — use service account, **never** restore `.read/.write: true`.
4. Data restore from `D:\dev\_forensic_backups\wellbuilt-sync-security-20260731-201322`.

---

## 9. Remaining risks

- Dual-run period leaves DB open until rules deploy (by design).
- Field data paths (packets, invoices, tickets) still need Auth-bound writes; secure rules currently **deny client writes** and expect CF expansion for ticket/packet ingest — **WB-T/WB-M will need additional CF work before full enforcement** or transitional authenticated write rules.
- App Check not enforced until `SECURITY_ENFORCE_APPCHECK=true` and clients ship providers.
- WB-M / Metro / wellbuilt-ewallet not fully dual-run patched in this commit set.
- Custom Auth UIDs `driver_*` create Auth users — monitor quota.
- Standalone free-tier still auto-approves **server-side** (rate-limited); may want invite-only later.

---

## 10. Immediate admin action (Mike)

After confirming backup files exist:

1. In Admin → Employees, **Reject** the two `wprjjg` pendings (do not delete).
2. Do **not** approve them.

---

## 11. Authorization request

Please authorize **one** of:

**A.** Deploy **functions only** (dual-run; rules still open) so new apps can use secure register/login.
**B.** Wait for WB-M/Metro/ewallet parity + emulator rules tests, then functions.
**C.** Emergency narrow containment (e.g. deny unauth write to `drivers/approved` only) — will break JSA self-approve and any client that still writes approved (logoutAt patches).

**Do not authorize full default-deny rules until all production devices run security builds and passcodes are reset.**
