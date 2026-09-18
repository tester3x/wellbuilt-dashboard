# Canonical Driver Reset Program: Authoritative Phase Gates & Verification Protocol

## Overview
This document defines the strict, sequential Stop/Go phase gates governing the Canonical Driver Reset control-plane implementation. Each gate must be independently validated and explicitly approved before subsequent phases can unlock.

**PERMANENT STATUS RULE**: All phases beyond Phase 0 remain strictly **LOCKED AND CLOSED**. Zero implementation, deployment, migration, or production data access for any future phase may occur without independent sign-off.

---

## Authoritative Phase Matrix

| Phase | Title | Objective | Status / Gate |
| :--- | :--- | :--- | :--- |
| **Phase 0** | **Disabled Contract Foundation Hardening** | Inert TypeScript schemas, pure validators, adversarial tests, architectural docs | **ACTIVE / SUBMITTED FOR REVIEW** |
| **Phase 1** | **Migration Compatibility & Read-Only Audit** | Non-destructive discovery of legacy hashes vs canonical scrypt and active state | **LOCKED / BLOCKED ON P0 APPROVAL** |
| **Phase 2A**| **Authoritative Server Schema & Storage Normalization** | Firestore schema migration rules, backfill of companyId and credentialVersion | **LOCKED** |
| **Phase 2B**| **Transaction & Version CAS Enforcement** | Compare-and-swap transaction engine, session version binding & revocation | **LOCKED** |
| **Phase 3** | **Client Forced-Change Support** | Mobile WB-T & Dashboard UI support for first-login temporary-to-permanent change | **LOCKED** |
| **Phase 4** | **Auth Cleanup Worker & Emulator Multi-Suite** | Durable forward-only background cleanup queue, emulator integration suite | **LOCKED** |
| **Phase 5** | **Deployment Review & Dark Launch** | Pre-deployment security review, dark launch under feature flag, zero-defect telemetry | **LOCKED** |
| **Phase 6** | **Governed Identity Reset (Adan Recovery)** | Attended administrative reset of Adan using verified canonical control plane | **LOCKED** |

---

## Detailed Stop / Go Phase Gate Specifications

### Gate 0: Phase 0 Independent Acceptance (Current)
- **Objective**: Establish side-effect-free, inert contracts and deterministic validators resistant to prototype poisoning, accessor execution, and parameter injection.
- **Stop Conditions**:
  - Any Firebase SDK import in contract or validator code.
  - Any export of reset contracts or validators to production entrypoints (`functions/src/index.ts`).
  - Any network, database, or cryptographic hashing side effects.
  - Any failure in the 172-test pure validator suite.
  - Any regression in the repository's 4 known baseline test failures.
  - Any mutation of production driver data or Adan's identity.
- **Go Conditions**:
  - Independent acceptance and audit clearance by Desktop Codex.
  - Clean TypeScript compilation (`tsc`).
  - 172 passing pure validator tests covering all adversarial counterexamples.
  - Exactly six Phase-0 files modified/tracked in the candidate commit.

---

### Gate 1: Migration Compatibility & Read-Only Audit
- **Objective**: Execute read-only discovery tooling to map driver credential formats across Firestore `driver_credentials` and RTDB `drivers/profiles`.
- **Prerequisites**: Unconditional clearance of Gate 0.
- **Stop Conditions**:
  - Any write, mutation, or update to Firestore or RTDB.
  - Automated in-band migration inside login or reset callables.
  - Unmasked logging of hashes, salts, or passcodes.
- **Go Conditions**:
  - Deterministic read-only census mapping drivers into:
    1. Canonical scrypt records with active profiles.
    2. Legacy SHA-256 records requiring attended migration.
    3. Records with missing `companyId` requiring tenant binding backfill.
    4. Records where `active` is missing vs `active: false` vs `active: true`.
  - Non-destructive migration plan approved by governance.

---

### Gate 2A: Authoritative Server Schema & Storage Normalization
- **Objective**: Formalize Firestore `driver_credentials` schema to include explicit `companyId`, `credentialVersion: 1`, and boolean `active: true`.
- **Prerequisites**: Gate 1 audit complete and validated.
- **Stop Conditions**:
  - Re-introducing client SHA-256 hashes or approved keys.
  - Destructive batch updates without rollback checkpoints.
- **Go Conditions**:
  - Normalized document schema deployed behind feature flag.
  - Firestore security rules asserting strict tenant data isolation.

---

### Gate 2B: Transaction & Version CAS Enforcement
- **Objective**: Implement atomic compare-and-swap mutation logic on `driver_credentials/{driverId}.credentialVersion`.
- **Prerequisites**: Gate 2A verified in staging environment.
- **Stop Conditions**:
  - Passcode hashing inside the Firestore transaction lock.
  - Network calls, RTDB writes, or Auth mutations inside the Firestore transaction.
  - Reliance on standalone boolean flags (`sessionRevoked`) without version CAS checking.
- **Go Conditions**:
  - Atomic transaction re-reads authoritative tenant membership, security policy, target driver binding, and credential version in its read set.
  - Pre-computed scrypt hashing outside transaction lock.
  - Proof of deterministic session revocation upon version increment.

---

### Gate 3: Client Forced-Change Support
- **Objective**: Implement client-side support in WellBuilt Ticket (WB-T) and Dashboard for forced passcode update upon initial login with a temporary passcode.
- **Prerequisites**: Gate 2B complete.
- **Stop Conditions**:
  - Allowing temporary passcodes to be used indefinitely without mandatory change.
  - Transmitting plaintext passcodes in unsecured logs or analytics.
- **Go Conditions**:
  - Mobile client intercepts `mustResetPasscode: true` or `temporary: true` custom claims/session response and immediately gates driver into change-passcode UI.
  - Driver successfully self-sets permanent passcode through authenticated self-change callable.

---

### Gate 4: Auth Cleanup Worker & Emulator Multi-Suite Validation
- **Objective**: Implement the asynchronous background worker processing `auth_cleanup_effects`, and validate the end-to-end pipeline in Firebase Emulator.
- **Prerequisites**: Gate 3 complete.
- **Stop Conditions**:
  - Attempting to roll back or delete canonical Firestore credentials if Auth cleanup fails.
  - Infinite retry loops without exponential backoff or dead-letter limits (`MAX_RETRY_ATTEMPTS = 5`).
- **Go Conditions**:
  - Multi-emulator automated test suite exercising:
    1. Concurrent reset requests against the same driver (exact CAS race assertion).
    2. Idempotent retry with identical `opId`.
    3. Conflicting retry with changed target parameters (rejection verified).
    4. Background Auth token revocation with simulated network failure and recovery.
    5. Terminal error dead-letter routing without credential state corruption.

---

### Gate 5: Deployment Review & Dark Launch
- **Objective**: Deploy the `resetDriverPasscode` callable to production under feature-flag control with zero tenant traffic.
- **Prerequisites**: Gate 4 passing in continuous integration.
- **Stop Conditions**:
  - Any security audit finding or unresolved risk item.
  - Deployment of unverified functions outside the approved target list.
- **Go Conditions**:
  - Formal deployment review and architecture sign-off.
  - Dark launch with zero traffic; telemetry confirms zero errors over 72 hours.

---

### Gate 6: Governed Identity Reset (Adan Recovery)
- **Objective**: Execute a supervised administrative reset of Adan's driver passcode using the verified canonical control plane.
- **Prerequisites**: Gate 5 operating successfully in production.
- **Stop Conditions**:
  - Any manual database patch or direct Firestore console edit.
  - Use of legacy hash or unverified script.
- **Go Conditions**:
  - Attended reset conducted by authorized tenant security officer.
  - Temporary numeric passcode generated with mandatory first-login change flag.
  - Immutable audit receipt and pending cleanup effect confirmed in Firestore.
  - Successful driver login and self-change verified in audit trail.
