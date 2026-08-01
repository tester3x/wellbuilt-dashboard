# FINAL PREBUILD CHECKPOINT — Custom tokens + residual callables + client cutover

**Date:** 2026-08-01  
**Project:** wellbuilt-sync  
**Stop line:** No client APK builds, no hosting deploy, no passcode reset of testers, no App Check enforcement, no secure rules deploy, no vc33 branch changes.

---

## 1. IAM principal, target, scoped role

| Field | Value |
|-------|--------|
| Runtime principal | `559487114498-compute@developer.gserviceaccount.com` |
| Target resource | Same service account (resource IAM, not project-wide) |
| Role | `roles/iam.serviceAccountTokenCreator` |
| IAM Credentials API | Enabled |
| Keys | None created |

See `security/IAM-TOKEN-CREATOR.md`.

## 2. Custom-token production result

| Check | Result |
|-------|--------|
| `createCustomToken` primary | **PASS** |
| Client `signInWithCustomToken` | **PASS** |
| ID token claims (`kind`, `driverId`, `companyId`, `roles`) | **PASS** |
| Expiry future | **PASS** |
| Stage A prod verify | **27/27** (`mintMethod=custom_token`) |

Identity revisions after gated-fallback deploy:

| Function | Revision |
|----------|----------|
| `authenticateDriver` | `authenticatedriver-00004-yak` |
| `registerStandaloneDriver` | `registerstandalonedriver-00004-laf` |

## 3. Password-exchange fallback disposition

- **Documented:** `security/PASSWORD-EXCHANGE-FALLBACK.md`
- **Audit:** No reusable plaintext or reversibly encoded password persisted or logged
- **Production default:** **DISABLED** (`ALLOW_PASSWORD_EXCHANGE_FALLBACK` must be exactly `true` for emergency only)
- **Code path retained** behind explicit env flag + audit `mintMethod` visibility
- Temp passwords: ephemeral memory → Auth hash only → immediate rotate via `invalidateSyntheticPassword`

## 4. Synthetic password credentials cleaned

- Per-request passwords rotated immediately after exchange (when fallback used historically)
- Auth identities **not deleted** (UID pattern `driver_*` retained for custom-token sessions)
- Disposable prod-verify drivers cleaned via `adminDeleteSecureDriver`
- No bulk delete of legitimate Auth users

## 5. Residual callable deployments and revisions

| Function | Revision | Status |
|----------|----------|--------|
| `upsertDriverInvoice` | `upsertdriverinvoice-00001-ney` | ACTIVE |
| `upsertDriverDispatch` | `upsertdriverdispatch-00001-wax` | ACTIVE |
| `sendChatMessage` | `sendchatmessage-00001-rig` | ACTIVE |
| `getPublicClientMeta` | `getpublicclientmeta-00001-nar` | ACTIVE |

## 6. Production verification results

| Suite | Result |
|-------|--------|
| Stage A operational (custom token + packet/shift/JSA/profile/storage) | **27/27 PASS** |
| Residual invoice/dispatch/chat/public meta | **16/16 PASS** (invoice cold-start flaked once earlier; re-run green) |
| Unauth residual writes | Rejected |
| Terminal reopen | Rejected |
| Chat idempotent clientId | PASS |
| Public meta size / no operational dumps | PASS |

## 7. Disposable records remaining

| Class | Disposition |
|-------|-------------|
| Secure drivers from verify scripts | Deleted via admin callable when tests complete |
| Disposable admin RTDB users | Demoted (`viewer` + `disabledForSecurityTest`) — may remain until Admin UI cleanup |
| Residual invoice/dispatch/chat seed docs | Deleted via open dual-run REST after verify |
| Suspicious pendings A/B | **Preserved** (not deleted) |
| Debug invoices `idem_inv-dbg-*` | Deleted |

**Preserve cleanup path:** Dashboard `adminDeleteSecureDriver` + `secureDriverAdmin.adminDeleteSecureDriver`.

## 8. WB-T full operational-cutover status

| Path | Status |
|------|--------|
| Invoice create/close dual-run → `upsertDriverInvoice` | **Done** (security branch; SAFE outbox executes through `createInvoiceDocIfAbsent` / close paths) |
| Dispatch status dual-run | **Done** |
| Chat send dual-run | **Done** |
| Packet ingest dual-run | **Done** (prior commit) |
| Offline queues / idempotency | **Preserved** |
| Silent drop after enforcement | **Avoided** — secure first, legacy fallback while open, outbox retains failures |
| `diag/first-photo-lifecycle` / vc33 | **Untouched** |
| App Check scaffold | `utils/appCheckInit.ts` (enforce off) |

## 9. eQuipment / DVIR cutover status

| Item | Status |
|------|--------|
| Existing `eQuipmentDocuments` / `eQuipmentDVIR` CF path | **Still primary** (already not open-DB) |
| Scoped Storage path helper | `services/secureOperationalApi.ts` |
| Dual-run path mint on upload | **Wired** (falls through to callable body until native uploadBytes Auth complete) |
| Offline resume/replay | **Preserved** via existing document store sync |
| App Check scaffold | In `secureOperationalApi.initAppCheckIfConfigured` |

## 10. Secure Admin UI readiness

| Capability | Status |
|------------|--------|
| `secureDriverAdmin` helpers | approve / reject / setPasscode / delete |
| DriversTab secure approve (simple + assignments) | Dual-run secure first |
| DriversTab secure reject | Dual-run secure first |
| Temp passcode + must-change | Server default temporary; client helper exposes `temporary` |
| Disposable cleanup callable | `adminDeleteSecureDriver` |
| No direct open-DB required for secure path | **Yes** (legacy RTDB fallback remains until full cutover) |

## 11. App Check emission readiness by app

| App | Scaffold | Enforcement |
|-----|----------|-------------|
| WB-T | Yes (`utils/appCheckInit.ts`) | **Off** |
| Suite | Yes (`src/core/services/appCheckInit.ts`) | **Off** |
| WB-M | Yes (`src/services/appCheckInit.ts`) | **Off** |
| JSA | Yes (`services/appCheckInit.ts`) | **Off** |
| eWallet | Yes (in secureOperationalApi) | **Off** |
| Dashboard | Not required for this phase (Admin Auth) | **Off** |

## 12. Remaining anonymous dependencies

While production rules remain open (dual-run):

- Legacy RTDB `drivers/approved` hash login (clients still fall back)
- Legacy open invoice/dispatch/chat writes if secure callable fails
- Public web API key in clients (expected)
- Anonymous RTDB/FS reads still possible until secure rules deploy
- eWallet large-image upload still uses callable base64 body as primary

## 13. Exact security branch HEADs

| Repo | Branch | HEAD |
|------|--------|------|
| dashboard | `security/database-containment` | `427690d` |
| WB-T | `security/database-containment` | `e7b69a5` |
| eWallet | `security/database-containment` | `ac02474` |
| Suite | `security/database-containment` | `9e38943` |
| WB-M | `security/database-containment` | `d9bedb5` |
| JSA | `security/database-containment` | `233ae4e` |

All pushed to origin.

## 14. One coordinated client-build cycle sufficient?

**Yes, after Mike review of this checkpoint** — identity + Stage A ops + residual ops are live with custom tokens; clients on security branches have dual-run adapters. Remaining for build cycle:

1. Ship security-branch clients with dual-run
2. Migrate credentials / temp passcodes (admin-driven, not bulk force)
3. Flip dual-run to secure-only when metrics clean
4. Then rules + App Check enforcement (later phases)

## 15. Proposed client/hosting deployment order

1. **Dashboard hosting** (secure Admin UI) — first, so ops can approve/set temp passcodes  
2. **Suite** (identity hub)  
3. **WB-T** (invoice/dispatch/chat/packet)  
4. **WB-M** (packets/shifts)  
5. **JSA**  
6. **eWallet / eQuipment**  
7. **Hosting residual** only if needed  
8. **Still later:** rules enforce → App Check enforce → remove dual-run fallbacks  

## 16. Production rules remain open and unchanged

**Confirmed.** No RTDB/Firestore/Storage secure rules deployed. Dual-run depends on open rules until coordinated cutover.

---

## Stop confirmation

**Do not begin client builds until Mike reviews this checkpoint.**
