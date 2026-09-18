# Canonical Driver Reset Control-Plane Architecture Design

## Status & Scope
- **Status**: DESIGN CHECKPOINT ONLY (Phase 0).
- **Execution Boundary**: Pure contract schema and validator definitions. Zero runtime code, zero production export, zero callable registration, zero Firebase mutations, zero production data access.
- **Permanent Hold**: Candidate `64c5271` is permanently rejected. No repairs or deployments of the mixed-purpose `adminSetDriverPasscode` flow. Adan and all real identities remain completely untouched.

---

## 1. Trust Boundaries & Threat Model

The prior rejected design (`64c5271`) suffered from critical architectural flaws:
1. **Ambiguous wire requests**: Allowed client callers to submit mixed-purpose payloads containing legacy names, approved keys, or self-asserted claims.
2. **Non-transactional multi-store mutations**: Attempted to synchronize Firestore credentials, RTDB profiles, and Firebase Auth simultaneously within non-atomic or ill-defined compensation blocks.
3. **Rollback hazards**: Failed secondary writes attempted to "compensate" by deleting or mutating canonical state, introducing authorization races and orphaned identity bindings.
4. **Token & claim inflation**: Injected capability claims directly from unverified inputs or stale tokens rather than resolving current tenant membership against canonical store authority.

### Phase 0 Trust Boundary Principles
- **Dedicated Single-Purpose Control Plane**: The future `resetDriverPasscode` callable performs exactly one operation: resetting the authentication credential of an existing canonical driver. It never provisions accounts, never registers new drivers, never converts legacy hashes, and never performs name-only resolution.
- **Caller Context Decoupling**: The wire request contains only target operational data. Actor identity (`actorUid`), tenant membership, and administrative capabilities are resolved server-side from authenticated session context and verified against authoritative database records.
- **Fail-Closed Policy**: If any identity attribute, tenant binding, version check, or policy capability is absent, malformed, or contradictory, the operation immediately aborts without side effects.

---

## 2. Canonical Records & Data Ownership

Authority is partitioned into distinct records with strict ownership boundaries:

| Record | Primary Store | Authoritative Role | Mutation Invariant |
| :--- | :--- | :--- | :--- |
| `driver_credentials/{driverId}` | Cloud Firestore | Root canonical credential store (`algo: scrypt`, parameters, salt, hash, version, active). | Mutated solely via transactional compare-and-swap on `credentialVersion`. |
| `companies/{companyId}` | Cloud Firestore | Tenant boundary & company security policy. | Read-only during driver reset. Must explicitly authorize reset capability. |
| `staff_principals/{uid}` | Cloud Firestore | Staff administrator identity & global tenant memberships. | Read-only during reset. Evaluated server-side outside request body. |
| `driver_sessions/{sessionId}` | Cloud Firestore / RTDB | Active driver session state. | Binds `sessionId`, `driverId`, `companyId`, `credentialVersion`. Invalidated on version CAS increment. |
| `driver_reset_receipts/{receiptId}` | Cloud Firestore | Immutable append-only audit trail of committed credential resets. | Written atomically with the credential CAS update. |
| `auth_cleanup_effects/{effectId}` | Cloud Firestore | Durable work queue for background Firebase Auth revocation/synchronization. | Written atomically with receipt; processed asynchronously by an idempotent worker. |
| `drivers/profiles/{driverId}` | RTDB | Projection-only display metadata (e.g. `displayName`, `phone`). | Projection only. Never overrides canonical Firestore credential authority. |

---

## 3. Request and Credential Contracts

### Canonical Reset Request (`CanonicalResetRequest`)
The future callable accepts exactly 6 wire fields:
```typescript
interface CanonicalResetRequest {
  readonly opId: string;                      // Non-empty canonical ID (1..128 chars), idempotency key
  readonly companyId: string;                 // Tenant scope (1..128 chars)
  readonly driverId: string;                  // Canonical driver ID (1..128 chars)
  readonly expectedCredentialVersion: number; // Positive safe integer (> 0)
  readonly temporary: boolean;                // Explicit boolean
  readonly newPasscode: string;               // 6..128 numeric digits (/^\d+$/)
}
```
**Invariants Enforced**:
- All 6 fields are strictly required.
- Unknown or extraneous keys are rejected immediately.
- `callerUid`, `role`, `roles`, `claims`, `capability`, `email`, `displayName`, `approvedKey`, and `legacyHash` are forbidden on the wire.
- Passcode must be string digits only (no type coercion, no whitespace, no non-numeric characters).

### Canonical Credential (`CanonicalCredential`)
Stored under `driver_credentials/{driverId}`:
```typescript
interface CanonicalCredential {
  readonly algo: 'scrypt';
  readonly N: number;                         // e.g. 16384 (power of 2, 1024..1048576)
  readonly r: number;                         // e.g. 8 (1..64)
  readonly p: number;                         // e.g. 1 (1..16)
  readonly keyLen: number;                    // e.g. 32 (16..128)
  readonly saltB64: string;                   // Base64-encoded salt (>= 16 bytes)
  readonly hashB64: string;                   // Base64-encoded scrypt derived key
  readonly driverId: string;                  // Explicit canonical driver ID
  readonly companyId: string;                 // Explicit canonical company ID
  readonly credentialVersion: number;         // Positive safe integer (> 0)
  readonly active: boolean;                   // Must be exactly true for reset eligibility
}
```
**Invariants Enforced**:
- `active` must be boolean `true`. Inactive or suspended drivers cannot have credentials reset.
- `driverId` and `companyId` must match the caller's target and authorization context.
- Scrypt parameters are strictly bounded.

---

## 4. Tenant Authority Model

Authorization evaluation proceeds in strict sequence:
1. **Authenticated Actor Identification**: `context.auth.uid` identifies the staff actor. Unauthenticated calls are rejected (`unauthenticated`).
2. **Tenant Membership Resolution**: Load staff membership record under `companyId`. Reject if staff actor is not an active member of the target company (`permission-denied`).
3. **Capability Verification**: Inspect company security policy and staff role assignments. The actor must hold the specific capability `canResetDriverPasscode`. Generic "manager" status does not automatically convey reset capability.
4. **Target Ownership Verification**: Confirm that the target `driverId` is an active canonical driver belonging to `companyId`.
5. **Separation of Privileges**: Temporary-passcode issuance and permanent-passcode issuance are separate capabilities. If `temporary: false`, caller must possess explicit `canIssuePermanentDriverPasscode` capability.

---

## 5. Credential-Version Compare-and-Swap (CAS) Transaction

The core credential reset executes within an isolated, atomic Cloud Firestore transaction:

```
[Staff Request]
       │
       ▼
1. Validate wire request (pure validator)
       │
       ▼
2. Resolve staff actor authority & tenant policy
       │
       ▼
3. Compute Scrypt hash OUTSIDE transaction (prevents transaction lock timeout)
       │
       ▼
4. Run Firestore Transaction:
   a. Read `driver_credentials/{driverId}`
   b. Assert driver exists, `active === true`, and `companyId === request.companyId`
   c. Assert `stored.credentialVersion === request.expectedCredentialVersion` (CAS guard)
   d. Write `driver_credentials/{driverId}` with new hash, salt, and version = stored.version + 1
   e. Write `driver_reset_receipts/{receiptId}` (immutable receipt)
   f. Write `auth_cleanup_effects/{effectId}` (durable pending cleanup effect)
   g. Commit transaction atomically
       │
       ▼
5. Return receipt & next version to caller
```

### Critical Corrections from Rejected Candidate
- **Pre-computed Hashing**: Scrypt derivation is computationally intensive (~100-300ms). Computing it inside the transaction risks contention and transaction retry storms. It is computed *before* opening the transaction. The transaction re-validates version and authority before accepting the prepared hash.
- **Atomic Double-Commit Elimination**: No RTDB writes, network calls, or Firebase Auth mutations take place inside the transaction.
- **Race Prevention**: If two administrators submit concurrent reset requests with `expectedCredentialVersion: 1`, exactly one transaction succeeds; the second fails the CAS condition (`stored.version === 2 !== 1`) and aborts cleanly without corrupting state.

---

## 6. Session and Revocation Contracts

Session integrity is tied directly to the `credentialVersion`:
```typescript
interface DriverSessionBinding {
  readonly sessionId: string;
  readonly driverId: string;
  readonly companyId: string;
  readonly credentialVersion: number;
}
```
- **Bound Session State**: When a driver authenticates or exchanges an SSO ticket, their session token / record binds `credentialVersion`.
- **Version Verification**: On every sensitive operation or session revalidation (`verifyDriverSession`), the session's `credentialVersion` is compared against `driver_credentials/{driverId}.credentialVersion`.
- **Deterministic Revocation**: When the credential version is incremented during a reset, all prior sessions are immediately invalid without requiring distributed token revocation lists or fragile `sessionRevoked` booleans.

---

## 7. Reset Receipt vs. Auth Cleanup Effect

A central architectural bug in earlier drafts was treating Auth cleanup as part of the receipt.

### Separation of Concerns
1. **Reset Receipt (`ResetReceipt`)**:
   - An immutable audit record of what the control plane *committed* in Firestore.
   - Status is always `'committed'`.
   - `authCleanupStatus` is initialized to `'pending'` or `'enqueued'`.
   - **Rule**: A reset receipt must *never* falsely claim Auth cleanup completed at receipt generation time.
2. **Auth Cleanup Effect (`AuthCleanupEffect`)**:
   - A durable work queue item processed asynchronously by a dedicated effect worker.
   - Responsible for revoking Firebase Auth refresh tokens (`admin.auth().revokeRefreshTokens(driverUid)`), updating custom claims, or clearing cached session claims.
   - Executes with idempotent, forward-only retry semantics.

### Forward-Only Recovery
- If the background Auth cleanup worker fails (e.g. Firebase Auth API rate-limit or network timeout), it retries with exponential backoff.
- **Under no circumstances does an Auth cleanup failure roll back or delete the canonical Firestore credential**. The credential update is already authoritative.

---

## 8. Legacy and Migration Boundary

The legacy system relied on client SHA-256 hashes and RTDB-stored approved keys.
- **Strict Quarantine**: The new `resetDriverPasscode` service will never read, generate, or accept client SHA-256 legacy hashes or approved keys.
- **No In-Band Migration**: Legacy drivers must be identified and migrated to canonical scrypt credentials in a dedicated, supervised migration phase (Phase 1).
- **Projection-Only RTDB**: RTDB nodes for drivers become read-only mirrors populated from canonical Firestore state after cutover.

---

## 9. Pending Mike Policy Decisions

The following policy decisions remain open and are explicitly NOT implemented in Phase 0:
1. **Attended Permanent Passcode Policy**: Whether tenant owners will ever be permitted to issue permanent passcodes directly, or whether 100% of administrative resets MUST be temporary passcodes requiring driver change upon first login.
2. **Role Granularity**: The exact RBAC matrix defining whether reset capability is restricted to Tenant Security Officers or delegable to Dispatch Supervisors.
3. **Session Revocation Grace Period**: Whether in-flight mobile job packets should be allowed a drain window or terminated instantly upon version CAS increment.

---

## 10. Phase 0 Implementation Status
Phase 0 establishes ONLY:
- Inert TypeScript interfaces and data contracts (`contracts.ts`).
- Pure validation functions with zero side effects (`validate.ts`).
- Exhaustive unit test coverage (`resetDesignContracts.test.ts`).
- Architectural documentation and phase gate specifications.

**Zero production execution paths exist. No production code imports or executes this design.**
