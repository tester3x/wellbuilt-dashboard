# Canonical Driver Reset Program: Phase Gates & Verification Protocol

## Overview
This document defines the authoritative Stop/Go gates for the Canonical Driver Reset control-plane implementation. Each phase must be explicitly reviewed and approved before the next phase opens.

**PERMANENT STATUS RULE**: Every phase after Phase 0 remains strictly **CLOSED**. No code, tool, or deployment for any subsequent phase may begin without explicit authorization from Mike.

---

## Phase Matrix

| Phase | Title | Focus | Current Gate Status |
| :--- | :--- | :--- | :--- |
| **Inventory** | Identity & Store Audit | Mapping legacy hash vs. canonical scrypt drivers | **CLOSED** |
| **Phase 0** | Disabled Contract Foundation | Inert schemas, pure validators, design docs, unit tests | **ACTIVE / PENDING REVIEW** |
| **Phase 1** | Migration Candidate Tooling | Read-only discovery & verification scripts | **LOCKED / CLOSED** |
| **Phase 2A** | Canonical Credentials & Lifecycle | Firestore credential schema & internal lifecycle | **LOCKED / CLOSED** |
| **Phase 2B** | Sessions & SSO Version Binding | Driver session bindings & token version guards | **LOCKED / CLOSED** |
| **Phase 3** | Reset Transaction Service | Dedicated `resetDriverPasscode` callable | **LOCKED / CLOSED** |
| **Phase 4** | Auth Cleanup Effect Worker | Durable asynchronous cleanup queue & worker | **LOCKED / CLOSED** |
| **Phase 5** | Application Integration | Dashboard UI and mobile client support | **LOCKED / CLOSED** |
| **Phase 6** | Independent Security Audit | External verification & pentest review | **LOCKED / CLOSED** |
| **Phase 7** | Controlled Production Cutover | Dark launch & gated tenant activation | **LOCKED / CLOSED** |
| **Phase 8** | Governed Adan Recovery | Supervised production recovery of Adan | **LOCKED / CLOSED** |

---

## Detailed Stop / Go Criteria

### Track: Inventory Track (Closed)
- **Objective**: Conduct a comprehensive inventory across Firestore `driver_credentials` and RTDB `drivers/profiles` without modifying data.
- **Stop Conditions**: Any script modifying production records, any write operations, or any unmasked output of driver credentials.
- **Go Conditions**: Read-only ledger documenting driver authentication models (legacy SHA-256 vs. canonical scrypt).

---

### Phase 0: Disabled Contract Foundation (Current)
- **Objective**: Define inert TypeScript contracts, pure deterministic validators, unit tests, and design documentation.
- **Stop Conditions**:
  - Any Firebase SDK import in contract or validator code.
  - Any export of `resetDesign` to production barrels (`index.ts`).
  - Any network, database, or cryptographic side effects.
  - Any edit to existing repository files.
  - Any reference to or mutation of real driver identities.
- **Go Conditions**:
  - Exactly 6 new files created.
  - 100% passing pure validator unit tests covering all 26 boundary cases.
  - Functions TypeScript compilation passes cleanly.
  - Zero candidate-only test regressions in the Functions test suite.
  - Verification of zero production imports/exports.
  - Atomic commit on `design/canonical-reset-phase0-20260918`.

---

### Phase 1: Migration Candidate Tooling (Closed)
- **Objective**: Build non-destructive tooling to discover drivers requiring migration from legacy hashes to canonical scrypt credentials.
- **Prerequisites**: Explicit sign-off on Phase 0.
- **Stop Conditions**: Automated in-band conversion inside reset paths; silent overwrites of conflicting profiles; touching Adan.
- **Go Conditions**: Standalone read-only audit CLI outputting deterministic migration candidates.

---

### Phase 2A: Canonical Credentials & Lifecycle (Closed)
- **Objective**: Establish the internal Firestore document schema and lifecycle handlers for `driver_credentials`.
- **Prerequisites**: Phase 1 audit complete and validated.
- **Stop Conditions**: Reliance on RTDB or Auth custom claims for canonical credential status.
- **Go Conditions**: Isolated Firestore security rules and internal data access layer with strict tenant isolation.

---

### Phase 2B: Sessions & SSO Version Binding (Closed)
- **Objective**: Update session generation and `verifyDriverSession` to compare `session.credentialVersion` against `credential.credentialVersion`.
- **Prerequisites**: Phase 2A complete and verified in staging.
- **Stop Conditions**: Use of standalone boolean flags (`sessionRevoked`) without version CAS validation.
- **Go Conditions**: Proof of deterministic session invalidation upon version increment.

---

### Phase 3: Reset Transaction Service (Closed)
- **Objective**: Implement the dedicated `resetDriverPasscode` Cloud Function callable.
- **Prerequisites**: Phase 2B complete; Mike's policy decisions on temporary vs. permanent passcodes resolved.
- **Stop Conditions**:
  - Re-use or patching of legacy `adminSetDriverPasscode`.
  - Passcode hashing inside the Firestore transaction.
  - Firebase Auth or RTDB mutations inside the Firestore transaction.
- **Go Conditions**: Atomic Firestore transaction with version CAS, receipt creation, and effect enqueuing.

---

### Phase 4: Auth Cleanup Effect Worker (Closed)
- **Objective**: Implement the asynchronous background worker to process `auth_cleanup_effects`.
- **Prerequisites**: Phase 3 complete.
- **Stop Conditions**: Rollback or deletion of canonical credentials upon worker failure.
- **Go Conditions**: Forward-only, idempotent retry engine with exponential backoff and dead-letter queue.

---

### Phase 5: Application Integration (Closed)
- **Objective**: Integrate the Dashboard administrative UI with `resetDriverPasscode`.
- **Prerequisites**: Phase 4 verified in emulator and staging.
- **Stop Conditions**: Client-side hashing or submission of authorization claims on the wire.
- **Go Conditions**: UI enforces temporary-by-default reset workflow and displays confirmed receipt IDs.

---

### Phase 6: Independent Security Audit (Closed)
- **Objective**: Full architectural and code audit by independent security reviewers.
- **Prerequisites**: Phase 5 complete.
- **Stop Conditions**: Any unresolved race condition, privilege escalation vector, or cross-tenant leakage.
- **Go Conditions**: Formal sign-off and penetration testing clearance.

---

### Phase 7: Controlled Production Cutover (Closed)
- **Objective**: Dark launch of `resetDriverPasscode` in production under feature-flag control.
- **Prerequisites**: Phase 6 sign-off.
- **Stop Conditions**: Any cutover failure; telemetry anomalies.
- **Go Conditions**: Zero defect telemetry over 72 hours of dark deployment.

---

### Phase 8: Governed Adan Recovery (Closed)
- **Objective**: Supervised administrative reset of Adan's driver passcode using the verified canonical control plane.
- **Prerequisites**: Phase 7 successfully operating in production.
- **Stop Conditions**: Any manual database edit, unmonitored execution, or legacy hash fallback.
- **Go Conditions**: Attended reset by authorized administrator with immutable audit receipt generated and verified.
