# Option A — Functions-only deploy report

**Date:** 2026-08-01  
**Project:** wellbuilt-sync  
**Result:** Security identity callables **deployed and live**. Production **rules unchanged** (anonymous access still open — expected for dual-run).

---

## 1. Predeploy tests (executed, not documented-only)

| Suite | Result |
|-------|--------|
| Passcode unit (`passcode.unit.test.js`) | **PASS** (incl. legacy 4-digit offline crack demo) |
| Secure rules adversarial (emulator) | **13 passed, 0 failed** |
| Callable integration (emulator) | **28 passed, 0 failed** |
| Full orchestrator `run-all-predeploy.mjs` | **exit 0** — `=== ALL PREDEPLOY EMULATOR TESTS PASSED ===` |
| `tsc` functions build | **PASS** |

Covered flows: register/status/login/approve/reject/temp passcode/mustChange/self-change/standalone/rate-limit/malformed input/admin auth denials/driver cannot admin/audit no plaintext/legacy seed untouched/disposable cleanup.

---

## 2. Deployed functions (additive creates)

All **new** (did not replace existing production functions):

| Function | Version | Region | Memory | Status |
|----------|---------|--------|--------|--------|
| `requestDriverRegistration` | v2 | us-central1 | 256MiB | **Created** |
| `checkDriverRegistrationStatus` | v2 | us-central1 | 256MiB | **Created** |
| `authenticateDriver` | v2 | us-central1 | 256MiB | **Created** |
| `driverChangeOwnPasscode` | v2 | us-central1 | 256MiB | **Created** |
| `adminListPendingRegistrations` | v2 | us-central1 | 256MiB | **Created** |
| `adminApproveDriverRegistration` | v2 | us-central1 | 256MiB | **Created** |
| `adminRejectDriverRegistration` | v2 | us-central1 | 256MiB | **Created** |
| `adminSetDriverPasscode` | v2 | us-central1 | 256MiB | **Created** |
| `adminDeleteSecureDriver` | v2 | us-central1 | 256MiB | **Created** |
| `registerStandaloneDriver` | v2 | us-central1 | 256MiB | **Created** |
| `adminComputeLegacyHash` | v2 | us-central1 | 256MiB | **Created** |

Deploy filter:  
`functions:dashboard:<name>` only.  
**Not deployed:** RTDB/Firestore/Storage secure rules, Hosting, clients, unrelated functions.

---

## 3. Production post-deploy verification

| Check | Result |
|-------|--------|
| Functions listed live | **Yes** (all 11) |
| Disposable `requestDriverRegistration` | **PASS** (`pendingId=f0852b59-…`) |
| Status pending | **PASS** |
| Login before approve fails | **PASS** |
| Unauth approve fails | **PASS** |
| Admin approve with real Admin Auth | **NOT COMPLETED** — no ADC/service account on workstation for `createCustomToken` / Admin SDK; Mike can complete via Dashboard once UI wired, or after `gcloud auth application-default login` |
| Secure login after approve | blocked on admin approve step |
| Wrong passcode | blocked on admin approve step |
| Audit records | Emulator verified; prod audit write occurs on successful callables (register created path exercised) |
| Disposable cleanup | Pending marked `status=rejected` / `prod-verify-cleanup` in RTDB secure+legacy; **Firestore `pending_credentials/{id}` may still exist** until Admin SDK delete |
| Suspicious A/B | **Preserved** (already `status: rejected` by Mike; not deleted) |
| Legacy RTDB anonymous read of `drivers/approved` | **Still 200** (rules still open — dual-run) |
| Forced passcode resets | **Not performed** |
| Auto-migrate on legacy login | **Not implemented** (by design) |

---

## 4. Passcode policy (clarified)

| Rule | Implementation |
|------|----------------|
| Min length | **6** characters (`PASSCODE_MIN_LEN`) |
| Short numeric PINs | **Rejected** if `^\d{1,5}$` on admin set |
| Legacy SHA not used as credential | **Yes** — scrypt only; `legacyHash` is profile metadata only |
| Admin temporary assignment | `temporary: true` **default** → `mustResetPasscode` |
| First secure sign-in | `authenticateDriver` returns `mustChangePasscode: true` + token; `driverChangeOwnPasscode` required |
| Audit | Never stores passcode plaintext |
| Existing Suite/WB-T UI | Login still accepts short passcodes client-side for **legacy** dual-run; secure path enforces 6+ at server |

---

## 5. Repository / commit state

| Path | Branch | Starting HEAD (this effort) | Current HEAD | Commits | Pushed? | Notes |
|------|--------|----------------------------|--------------|---------|---------|-------|
| `D:\dev\Dashboard` | `security/database-containment` | `710c8e9` (first sec commit) / pre was `5e5c0f3` | `0d903ca` | `710c8e9`, `55d007f`, `0d903ca` | **No** | Functions source; secure rules drafts; tests |
| `D:\dev\Suite` | `security/database-containment` | `05e2d41` (master) | `247e718` | dual-run driverAuth | **No** | |
| `D:\dev\WB-M` | `security/database-containment` | `c71b1af` | `c2f85b4` | dual-run | **No** | |
| `D:\dev\eWallet` | `security/database-containment` | `8b3117e` | `c7937db` | dual-run | **No** | |
| `D:\dev\JSA` | `security/database-containment` | `b4f3e46` | `3d26c61` | remove self-approve | **No** | |
| `D:\dev\WB-T` | security commit on `security/database-containment` | `1af93c2` / later `34feb11` | sec `a196346` | security only | **No** | Working tree back on **`diag/first-photo-lifecycle` ahead 9** with security files staged; **not mixed into pushed stack**. Unrelated JSA close commits remain local. |
| wellbuilt-ewallet / Metro / WB-M-delivery | — | — | — | none | — | No security edits this pass |

**Nothing pushed** to remotes for security work.

---

## 6. Production mutations this session

1. **Created 11 Cloud Functions** (additive).  
2. **Disposable registration** created then **rejected** (`SecDispms9pl411` / pending `f0852b59-…`).  
3. **Did not** change rules, hosting, or approved drivers.  
4. **Did not** force passcode resets.  
5. Suspicious pendings already rejected by Mike prior to this deploy (unchanged content except prior reject).

---

## 7. Remaining blockers before security client builds + rule enforcement

1. Complete prod admin approve/login verification with ADC or Dashboard admin UI.  
2. Build/distribute security-enabled apps (Suite, WB-T, WB-M, JSA, eWallet).  
3. User-controlled passcode migration for legitimate drivers (`adminSetDriverPasscode` temporary → `driverChangeOwnPasscode`).  
4. Wire operational write paths (packets, invoices, tickets, storage) to Auth/callables before default-deny.  
5. App Check enrollment + `SECURITY_ENFORCE_APPCHECK=true`.  
6. WB-T reconcile security branch vs `diag/first-photo-lifecycle` stack before production APK.  
7. Clean leftover Firestore `pending_credentials/f0852b59-…` with Admin SDK when ADC available.

### Paths still preventing default-deny (not fixed by this deploy)

- Entire RTDB (open rules)  
- Firestore invoices/tickets/dispatches/chat/jsas/companies writes  
- Storage photos/jsa/ewallet open rules  
- Mobile direct REST without Auth  

**Anonymous database exposure is NOT contained** after Option A — by design.

---

## 8. Stop

Awaiting next authorization for: client builds, credential migration, operational path hardening, then **rule enforcement** (still unauthorized).
