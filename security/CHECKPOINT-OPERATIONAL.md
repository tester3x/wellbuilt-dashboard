# CHECKPOINT — Operational Path Hardening (no production deploy)

**Date:** 2026-08-01  
**Stop for Mike review. No production deploy in this pass.**

---

## 1. Preservation commit (Phase 0)

| Item | Value |
|------|--------|
| Commit | `815fe85399ec0791d409ac656dd4cc2fb273d9af` |
| Message | docs(security): preserve Option A postdeploy report and prod verify script |
| Remote | `origin/security/database-containment` includes this and later `8591e46` |
| Excluded | forensic backups, Auth exports, `_phase1-deployed.json`, credentials |

---

## 2–3. Matrix & architecture

See:

- `security/OPERATIONAL-PATH-MATRIX.md` (summary + critical blockers)
- Explore agent full inventory (session) covering all domains
- `security/IDENTITY-ARCHITECTURE.md` (identity plane)
- `security/OFFLINE-OUTBOX-MIGRATION.md`
- `security/CLIENT-BUILD-AND-TESTER-MATRIX.md`

**Architecture summary:**

| Workload | Mechanism |
|----------|-----------|
| Identity | Live callables (already prod) |
| Packets | **New** `ingestDriverPacket` → Admin write `packets/incoming` → existing trigger |
| Shifts | **New** `upsertDriverShift` |
| JSA | **New** `submitJsaRecord` |
| Profile/logout | **New** `updateDriverProfile`, `signalDriverLogout` |
| Reference | **New** `getDriverReferenceBundle` |
| Photos/PDF | Direct Storage + Auth rules; **New** `requestStorageUploadPath` for allowed path |
| Invoices/tickets | Prefer existing CFs; draft rules **deny client write** |
| Chat | Residual gap — rules deny write; need message CF next |

---

## 4. Repos / branches / commits

| Repo | Branch | HEAD (pushed) | Key files |
|------|--------|---------------|-----------|
| Dashboard | `security/database-containment` | **`8591e46`** | operational/* callables, rule drafts, docs, tests |
| WB-T | `security/database-containment` | **`d01a961`** | `secureOperationalApi.ts`, packet dual-run in `firebase.ts` |
| WB-M | `security/database-containment` | **`f327175`** | packet dual-run |
| Suite | `security/database-containment` | **`1fb64ed`** | operational helpers |
| JSA | `security/database-containment` | **`cabc443`** | JSA submit helpers |
| eWallet | `security/database-containment` | `c7937db` (auth only; no op commit this pass) | |

**Not touched:** `diag/first-photo-lifecycle` / vc33.

---

## 5. Emulator results

| Suite | Result |
|-------|--------|
| Passcode unit | PASS |
| Rules adversarial | **14 passed, 0 failed** |
| Identity callables | **28 passed, 0 failed** |
| Operational | **20 passed, 0 failed** |
| Orchestrator | **exit 0** — ALL PREDEPLOY + OPERATIONAL PASSED |

---

## 6. Remaining direct anonymous dependencies

Until production rules change + clients cut over:

- Open RTDB/FS/Storage (current production rules)
- WB-T invoice/ticket/dispatch/chat client writes (not fully dual-run)
- Full tree `packets/processed` reads
- wellbuilt-ewallet legacy `driver_documents`
- Chat message write CF not built

---

## 7–9. Client / tester / offline

See matrices in repo. **No resets this pass.**

---

## 10. Proposed future deploy order

1. Deploy operational callables only  
2. Build/install security clients  
3. Dual-run soak  
4. Credential migration (temporary → first change)  
5. Chat/invoice residual callables if needed  
6. Enforce secure rules  
7. Anonymous probes  

---

## 11. Rollback (without world-open restore)

- Redeploy prior function revisions  
- Keep secure rules if already enforced  
- Use Admin SDK + forensic backup for data  
- **Never** re-open `.read/.write: true`  

---

## 12. Production left unchanged this pass

- Functions: still **only** the 11 identity callables from Option A (operational **not** deployed)  
- Rules/hosting/data/passcodes: **unchanged**  

---

## 13. Can default-deny be safely enforced now?

**No.** Residual client-direct invoice/ticket/dispatch/chat paths and un-deployed operational callables + unbuilt security APKs block enforcement.

**Closest path:** deploy operational functions → ship dual-run clients → drain queues → migrate credentials → close chat/invoice gaps → then rules.

---

## 14. Unresolved blockers

1. Operational functions not in production  
2. Invoice/ticket/chat dual-run incomplete  
3. Full invoice SAFE outbox → Auth replay not fully wired  
4. Emulator RTDB namespace drift for legacy-hash transitional (soft residual)  
5. App Check not enforced  
6. Credential migration not started  

---

**Stopped for Mike review. No production deploy.**
