# Canonical Driver Reset Control-Plane Architecture Design

## Status & Scope
- **Status**: HARDENED DESIGN CHECKPOINT ONLY (Phase 0 Hardening).
- **Execution Boundary**: Pure inert contract schemas and deterministic validators. Zero runtime code, zero production exports, zero callable registration, zero Firebase mutations, zero production data access.
- **Permanent Hold**: Prior candidates `64c5271` and unhardened Phase 0 foundation are superseded. Adan and all real identities remain completely untouched. Phase 1 remains strictly locked.

---

## 1. Trust Boundaries & Architectural Threat Model

The initial implementation attempt (`64c5271`) and rejected Phase-0 foundation suffered from critical architectural defects:
1. **Conflated Authority Planes**: Treated a global staff identity as having implicit tenant mutation privileges without requiring verified tenant membership and explicit reset capability grants.
2. **Ambiguous Wire Requests & Parameter Injection**: Allowed wire callers to inject caller identity, roles, or claims, and lacked strict own-property plain-data enforcement.
3. **Rollback Hazards & Atomic Double-Commit**: Attempted multi-store compensation where failed secondary operations attempted to delete or mutate canonical state, introducing authorization races and orphaned identity bindings.
4. **Invented Cryptographic Fixtures**: Used test fixtures with mismatched hash lengths (40-byte hash with 32-byte keyLen) and unbounded scrypt profiles rather than deriving bounds from the repository's authoritative credential writer.
5. **Lack of Operand Validation in Composite Helpers**: Assumed operands were pre-validated, risking unexpected type coercion or false positives on malformed structures.

### Hardened Trust Boundary Principles
- **Dedicated Single-Purpose Control Plane**: The future `resetDriverPasscode` service performs exactly one operation: updating the authentication credentials of an existing canonical driver under strict tenant governance. It never registers drivers, converts legacy hashes, or resolves drivers by display name alone.
- **Strict Separation of Authority Planes**: A global staff authentication identity alone carries ZERO tenant mutation power. Reset authority requires independent validation of tenant membership, tenant role capabilities, company security policy, and target driver ownership.
- **Authoritative Transaction Read Set**: Pre-transaction snapshots are insufficient for mutation authorization. The future Firestore transaction MUST re-read current tenant membership, role/capability authority, tenant policy, target binding, credential/version, and the operation journal inside its atomic read set.
- **Plain Data Only**: Validators never validate-then-reread attacker input. They take one own-data-descriptor snapshot, copy validated values into a fresh detached object, and freeze only that copy. Accessors, symbols, hidden properties, holes, exotic prototypes, custom iterators, cycles, and unknown fields are rejected. Proxy/revoked-proxy trap failures return one static bounded error and never echo attacker messages.
- **Secrets Boundary**: Plaintext passcodes exist solely in the wire request and the internal `ValidatedSecretBearingResetRequest` type. Secrets NEVER appear in receipts, cleanup effects, logs, errors, or public results.

---

## 2. Current Source Reality vs. Future Design Schema

To avoid architectural confusion, the platform's current production state is rigorously distinguished from the future canonical target design:

| Attribute / Feature | Current Production Reality (`functions/src`) | Future Target Design (Phase 2+) |
| :--- | :--- | :--- |
| **Credential Storage** | `driver_credentials/{driverId}` with nested `passcode: ScryptRecord` (`algo`, `N`, `r`, `p`, `keyLen`, `saltB64`, `hashB64`). | `driver_credentials/{driverId}` with normalized top-level scrypt fields, explicit `companyId`, and `credentialVersion`. |
| **Driver Identity** | Document ID in Firestore supplies `driverId`. | Document ID supplies `driverId`; explicit internal `driverId` property. |
| **Tenant Ownership** | `companyId` is NOT stored on `driver_credentials`; it resides in RTDB profile `drivers/profiles/{driverId}`. | Explicit `companyId` on canonical Firestore credential document. |
| **Liveness Check** | Production evaluates `active !== false` (missing `active` is treated as active). | Strict boolean `active: true` required for reset eligibility. Migration gate required before enforcement. |
| **Passcode Format** | Registration (`passcode.ts`) accepts any string of 6..128 characters (letters, numbers, symbols, spaces). | Numeric-only digits (6..128 digits) is a future administrative reset-command policy for temporary codes. |
| **Version CAS** | Does NOT exist today. Credential documents have no `credentialVersion` field. | Compare-and-swap on `credentialVersion` (positive safe integer, 1..1,000,000). |
| **Self-Change** | `driverChangeOwnPasscode` already exists. It hashes a new passcode and updates `driver_credentials` but does **not** perform transactional version/CAS. | Keep the callable; add version CAS and journal reread in a later phase. |
| **Auth Cleanup** | In-band, synchronous attempts with compensation hazards. | Asynchronous, durable, forward-only background worker (`AuthCleanupEffect`). |

---

## 3. Distinct Authority Planes Architecture

Authority is partitioned into six distinct contracts across independent planes:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. StaffPrincipal (Firebase Auth)                           │
│    Global authenticated actor: staffUid, email, verified    │
│    * ZERO tenant mutation power on its own *                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. TenantMembership (Firestore: company_memberships)        │
│    Binds staffUid to companyId; status must be 'active'     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. TenantRoleCapabilities (Firestore: tenant_roles)         │
│    Grants canResetDriverPasscode, canIssuePermanentPasscode │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. TenantSecurityPolicy (Firestore: companies/{companyId})  │
│    Governance rules: allowAdminReset, temporary vs perm     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. TargetDriverBinding (Firestore / RTDB canonical profile) │
│    Asserts driverId belongs to companyId; active === true   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. ResetAuthzSnapshot (Pre-transaction evaluated snapshot)  │
│    Point-in-time assertion of cross-plane consistency       │
└─────────────────────────────────────────────────────────────┘
```

### Authoritative Transaction Read Set
When **Phase 2B** executes the mutation transaction:
1. The transaction **MUST NOT** trust claims or pre-computed snapshots blindly.
2. The transaction read set **MUST** fetch and re-validate:
   - current tenant membership
   - current role/capability authority
   - current tenant security policy
   - target driver binding
   - current credential document and `credentialVersion`
   - operation journal / existing commitment
3. If any read-set record has changed or been revoked concurrently, the transaction aborts with zero side effects.

---

## 4. Plain Data & Input Sanitization Model

All incoming and internal objects are snapshotted before validation:
- Obtain one own-property descriptor snapshot (bounded exception handling around every reflection).
- Use own enumerable data descriptors only. Reject accessors, symbols, hidden properties, holes, exotic prototypes, custom iterators, malformed arrays, and unknown fields.
- Validate descriptor values, then build a fresh detached copy. Freeze only the copy and the success/error wrapper. Never spread, destructure, iterate, stringify, or deep-freeze the original input.
- Reject cycles, excessive depth, excessive keys, oversized strings, and oversized arrays before expensive allocation.
- Polluted `Object.prototype` / inherited `staffUid` / inherited membership never authorize. Role/capability arrays are dense bounded strings only.
- Policy fields require exact validated numbers and booleans. Invalid reset modes are rejected, never defaulted to temporary. Permanent reset is forbidden when policy requires temporary reset.
- Commitment hashes must match `hmac-sha256:<64 lowercase hex>`. Phase 0 does not hash. Plaintext and low-entropy hashes are not stored or exposed.

---

## 5. Scrypt Validation Grounded in Authoritative Source

Cryptographic constraints are derived strictly from `functions/src/security/passcode.ts`:
- **Repository Writer Standard**:
  ```typescript
  SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 }
  // Salt: crypto.randomBytes(16) -> 16 bytes
  ```
- **Strict Canonical Base64**: Decodes string to buffer, re-encodes to base64, and asserts string equality (`buf.toString('base64') === str`). Rejects malformed padding, corrupted trailing bits, and whitespace.
- **Decoded Length Invariants**:
  - `saltB64`: Decoded bytes must be between 16 and 32 bytes (`SCRYPT_BOUNDS.minSaltBytes` and `maxSaltBytes`).
  - `hashB64`: Decoded bytes must **strictly equal** `keyLen` (exactly 32 bytes for repository standard).
- **Resource Footprint Ceiling**:
  - Scrypt memory footprint is bounded: `128 * N * r <= 32 MB` (`33,554,432 bytes`).
  - Parameter `N` must be a power of two between 1024 and 65536.
  - Multi-gigabyte profiles (e.g. `N = 1048576, r = 64`) are rejected to prevent denial of service.
- **Phase 0 Rule**: Zero hashing or key derivation occurs in Phase 0. Only parameter validation is performed.

---

## 6. Enforceable Operation & Lifecycle Contracts

### Secret Handling Boundary
- **`CanonicalResetRequest`**: Wire contract containing `newPasscode`.
- **`ValidatedSecretBearingResetRequest`**: Explicitly named internal type containing `newPasscode` and commitment hash.
- **`CanonicalResetOperationCommitment`**: Sanitized public representation replacing `newPasscode` with `passcodeDigitCount` and a server-keyed `commitmentHash` (`hmac-sha256:<64 lowercase hex>`). Phase 0 validates format only.
- **Receipts & Effects**: `ResetReceipt` and `AuthCleanupEffect` NEVER contain passcode or credential secrets.
- **Runtime Immutability**: All validator return values are recursively frozen via `deepFreeze()`.

### Forward-Only Lifecycle & Conflict Fencing
- **Receipt Integrity**: `ResetReceipt.status` is always `'committed'`. `authCleanupStatus` is `'pending'` or `'enqueued'`. A receipt can NEVER claim completed auth cleanup at creation time.
- **Forward-Only Transitions**:
  - `pending` -> `in_progress`
  - `in_progress` -> `completed` | `failed`
  - `failed` -> `in_progress` (retry up to `MAX_RETRY_ATTEMPTS = 5`)
  - `completed` -> terminal (no transitions or replays permitted)
- **Fence Generation**: Every retry increments `fenceGeneration`. Stale workers with regressed fence generations are rejected.
- **No Rollback Rule**: If the background Auth cleanup worker fails, it logs a terminal error and enters dead-letter quarantine. It **NEVER** rolls back, deletes, or mutates the committed Firestore credential.
- **Idempotency vs. Conflict**:
  - Re-submitting an identical operation (`opId` with identical parameters) returns the existing commitment.
  - Re-using `opId` with conflicting parameters (different target driver, company, or version) is rejected with `idempotent_retry_conflict`.

---

## 7. Open Policy Decisions (Deferred to Governance)
1. **Permanent Passcode Authority**: Whether tenant administrators may ever issue permanent passcodes directly, or whether all administrative resets must be temporary codes requiring client change on first use.
2. **Role Granularity**: Whether reset capability is restricted to Tenant Security Officers or delegable to Dispatch Supervisors.
3. **Session Invalidation Grace Period**: Whether active mobile haul sessions have a brief drain period or are immediately invalidated on version increment.
