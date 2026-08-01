# Client-build readiness checkpoint

**Date:** 2026-08-01  
**Stop:** no client builds, no rule enforcement, no App Check enforce, no credential resets.

---

## 1. Stage A deploy results

| Callable | Action | Status |
|----------|--------|--------|
| `ingestDriverPacket` | **create** | Live us-central1 |
| `upsertDriverShift` | **create** | Live |
| `submitJsaRecord` | **create** | Live (512MiB) |
| `updateDriverProfile` | **create** | Live |
| `signalDriverLogout` | **create** | Live |
| `getDriverReferenceBundle` | **create** | Live |
| `requestStorageUploadPath` | **create** | Live |
| `authenticateDriver` | **update** | Password-exchange fallback for missing signBlob |
| `registerStandaloneDriver` | **update** | Same mint path |
| `adminDeleteSecureDriver` | **update** | Token uid helper |

None of the seven ops replaced existing non-security functions. Identity set remains healthy.

**Follow-up fix deployed:** `createCustomToken` failed without `iam.serviceAccounts.signBlob`; server now falls back to Admin password + Identity Toolkit exchange (`mintMethod=password_exchange`).

---

## 2. Production verification (disposable only)

**Result: 26/26 PASS** (`stage-a-prod-verify.mjs`)

Covered: unauth reject ×7, admin provision, authenticate (password_exchange), packet + idempotency, oversized reject, shift + foreign reject, JSA, profile, logout, reference, storage path + cross-company reject, wrong passcode, legacy open, suspicious preserved, cleanup.

### Disposable paths (last successful run)

| Kind | ID / path |
|------|-----------|
| Admin email | `sec-op-admin-ms9scdbl@test.local` |
| Admin Auth uid | `hRY8VOuT2VXCNZYcKO7DGyFU9Zb2` (demoted to viewer) |
| Driver displayName | `SecOpDrvms9scdbl` |
| Driver id | `b48a0972-0a6b-46c9-849e-47aef98a6412` (**deleted** via adminDeleteSecureDriver) |
| Packet key | `idem_stage-a-ms9scdbl-pkt1` (may remain under `packets/incoming` if not processed) |
| Shift doc | `b48a0972-…_2026-08-01` (orphaned after driver delete — low risk) |
| JSA id | `idem_stage-a-jsa-ms9scdbl` |
| Storage path issued (no file uploaded) | `photos/security-test/inv-ms9scdbl/…jpg` |
| Earlier leftover | `pending_credentials/f0852b59-6bdd-46d3-a8d8-c2a0276afa2f` (from Option A) |

---

## 3. Cleanup

| Item | Status |
|------|--------|
| Secure driver credentials/profile/Auth | **Deleted** via adminDeleteSecureDriver |
| Disposable admin Auth | **Remains** (demoted RTDB role=viewer); Auth account not deleted without Admin SDK service account |
| Packet/JSA/shift docs | May remain; no PII beyond test labels |
| Open-client deletes | **Not used** for cleanup of credentials |

---

## 4. Existing-user compatibility

- Production rules **still open** (dual-run)
- Approved drivers **unchanged**
- Suspicious A/B still **rejected** + preserved
- No forced passcode migration
- Original 11 identity callables live; ops additive

---

## 5. Residual hardening commits (local/pushed security branches)

| Repo | HEAD | Content |
|------|------|---------|
| Dashboard | *(push after this file)* | invoice/dispatch/chat callables, public meta, App Check plan |
| WB-T | security branch | secure invoice/dispatch/chat helpers + App Check scaffold |
| Suite | security branch | idToken path + App Check scaffold |
| WB-M / JSA | prior dual-run | packet/JSA helpers already pushed |

**Residual callables not yet production-deployed:**  
`upsertDriverInvoice`, `upsertDriverDispatch`, `sendChatMessage`, `getPublicClientMeta`

---

## 6. Direct anonymous dependencies remaining

- Open RTDB/FS/Storage rules (by design until soak)
- WB-T invoice/ticket/chat client paths not fully switched (helpers ready)
- wellbuilt-ewallet legacy `driver_documents` if that APK ships
- Full `packets/processed` tree reads
- Native App Check not producing tokens yet

---

## 7. App Check status

| App | Init scaffold | Production enforce |
|-----|---------------|--------------------|
| WB-T / Suite | Yes (no secrets) | **Off** |
| WB-M / JSA / eWallet / Dashboard | Plan only | Off |
| Server `SECURITY_ENFORCE_APPCHECK` | false | Do not enable until clients installed |

---

## 8. Emulator results (latest)

- Rules: 14 pass  
- Identity: 28 pass  
- Operational (+ invoice/chat/public meta): **25 pass**  
- Orchestrator: exit 0  

---

## 9. Apps requiring one coordinated security build

1. WB-T (security branch based on vc33)  
2. WB-M  
3. Suite  
4. JSA  
5. eWallet  
6. Dashboard hosting (admin UI for secure approve/reset)  

---

## 10. Tester migration order

See `CLIENT-BUILD-AND-TESTER-MATRIX.md` — MikeS24 → Mikezfold → TabletS10 → Marcial → AdanS → Wisho-135 → iPhone16 → AcmeMike; Test Auth deactivate optional; ABurger inactive skip.

---

## 11. Secure Admin UI readiness

- Callables live: approve/reject/set passcode/list/delete  
- DriversTab reject wired dual-run; full approve-via-securePendingId still partial  
- **Not fully ready** as sole path — dual-run UI OK for soak  

---

## 12. Ready for soak period?

**Yes, for Stage A ops + identity dual-run** with open rules.  
**Not yet** for default-deny or App Check enforce.

---

## 13. Proposed build/install order

1. Deploy residual callables (invoice/dispatch/chat/public meta)  
2. Build Dashboard hosting  
3. Build Suite → WB-T → WB-M → JSA → eWallet  
4. Install Mike first, then Liquid Gold testers  

---

## 14. App Check enforce order

1. Clients emit tokens  
2. Monitor attach rate  
3. `SECURITY_ENFORCE_APPCHECK=true` on callables  
4. Then rules  

---

## 15. Default-deny enforce order

1. Residual callables deployed  
2. Clients dual-run soak ≥1 field day  
3. Credential migration  
4. `REQUIRE_DRIVER_CLAIMS=true`  
5. Deploy secure rules  
6. Anonymous probe  

---

## 16. Rollback

- Roll back functions to previous revision  
- Keep dual-run clients working against open rules  
- Never restore world-open rules if already tightened  

---

## 17. Confirmation

**Production rules remain unchanged/open.** No client builds/installs, no passcode resets, no App Check enforcement this pass.
