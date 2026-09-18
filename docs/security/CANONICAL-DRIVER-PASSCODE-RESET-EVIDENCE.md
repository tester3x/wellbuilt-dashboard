# Canonical Driver Reset Phase 0 Hardening V2: Verification Evidence

## Baseline & Target Metadata
- **Repository**: `tester3x/wellbuilt-dashboard`
- **Frozen Repair Parent**: `23f1e69081467b1b9825e21e34dde08f1aa063d0`
- **Target Branch**: `fix/canonical-reset-phase0-hardening-v2-20260918`
- **Candidate Commit Scope**: One atomic documentation+validator repair on parent `23f1e690`. Prior commit is not amended.

No universal safety guarantee is claimed beyond the executable tests in this suite.

---

## Strict Six-File Inventory
This v2 repair modifies exactly the six logical Phase-0 artifacts:

1. `functions/src/security/resetDesign/contracts.ts`
2. `functions/src/security/resetDesign/validate.ts`
3. `functions/src/security/__tests__/resetDesignContracts.test.ts`
4. `docs/security/CANONICAL-DRIVER-PASSCODE-RESET.md`
5. `docs/security/CANONICAL-DRIVER-PASSCODE-RESET-PHASES.md`
6. `docs/security/CANONICAL-DRIVER-PASSCODE-RESET-EVIDENCE.md`

The prior hardening commit `23f1e690` described six logical artifacts but Git recorded **nine** changed paths: three documentation adds, three documentation deletes (rename), and three code mods.

---

## Codex HOLD F1–F10 and P2 mapping

| ID | Finding | Correction |
| :--- | :--- | :--- |
| **F1** | Validate-then-reread attacker input; freeze original | Own-data-descriptor snapshot, detached copy, freeze copy/wrapper only |
| **F2** | Inherited authority / prototype pollution | Snapshot copies own enumerable data descriptors only; inherited `staffUid` / `canResetDriverPasscode` never authorize |
| **F3** | Policy defaults and silent temporary mode | Exact numeric/boolean policy fields; invalid `resetMode` rejected; permanent forbidden when `requireTemporaryOnReset` |
| **F4** | Incomplete idempotency / low-entropy hash | Full commitment validation; bind op/actor/tenant/driver/mode/version/creation/hash; `hmac-sha256:<64 hex>` format only |
| **F5** | Retry fence/lifecycle holes | Attempts cannot decrease; max retries; increment on new attempt; fence advances; createdAt immutable; completed terminal |
| **F6** | Cleanup secret/status schema holes | Status-specific exact fields; no unknown/secret fields on effects/receipts/commitments |
| **F7** | Current credential writer fields omitted | Allow `pendingId`, `setBy`, `temporaryAssigned`, `opId`, `passcodeChangedAt`; return detached copy |
| **F8** | Bounds/chronology/wrapper freeze | Pre-decode base64 size; calendar-valid UTC round-trip; incrementable versions; freeze result wrappers |
| **F9** | Docs: missing self-change, wrong phase, 6 vs 9 paths, universal safety | `driverChangeOwnPasscode` exists (missing CAS); Phase 2B is the transaction; nine Git paths noted; no universal guarantee |
| **F10** | Missing executable Codex counterexamples | V2 tests execute production validators for proxies, inherited authority, sparse arrays, policy, retry, credentials, dates, versions |
| **P2** | Nested getters/iterators, malformed arrays, contradictory cleanup, actor/hash validation, oversized arrays/depth | Snapshot rejects accessors/symbols/holes/exotic arrays/iterators; status schemas; bounded arrays/depth; static inspect errors |

---

## Migration and rollback (Phase 0)

- **Migration**: none. Phase 0 is inert. No Firestore/RTDB writes.
- **Rollback**: revert this single commit. Production entrypoints do not import `resetDesign`.
- **Later phases**: credential backfill of `companyId`/`credentialVersion` remains locked behind Gate 1 read-only audit.

---

## Numeric reset policy scope

- Temporary administrative reset: `resetMode: 'temporary'`, `requireTemporaryOnReset` may be true, `allowPermanentPasscodeReset` must be false in that combination.
- Permanent administrative reset: `resetMode: 'permanent'` requires `allowPermanentPasscodeReset`, `canIssuePermanentPasscode`, and `requireTemporaryOnReset === false`.
- Length bounds `requiredPasscodeMinLength` / `maxPasscodeLength` must be exact integers in `6..128` with min <= max.

---

## Validation Execution Logs

Recorded in the v2 return packet: focused suite, independent adversarial probes, TypeScript build, full Functions suite vs parent baseline (967 passed / 4 baseline failures / 35 skipped).
