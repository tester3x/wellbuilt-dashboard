# Production Water Vertical-Slice Field-Test Manifest (G-018R1)

Prepared: 2026-09-22
Lane: Local release preparation, deterministic packaging, and pre-deployment inspection only.
Nothing in this directory or manifest has been executed against production.

---

## 1. Lineage & Repository Checkpoints

| Component | Target / Package | Accepted Source SHA | Release Branch | Release Tip SHA | Status / Worktree |
|---|---|---|---|---|---|
| **Contracts** | `@tester3x/wellbuilt-contracts@0.7.0` | `a46e91e20227ebb2c5a0e86e5da8732b75666d69` | (published tag `v0.7.0`) | `a46e91e20227ebb2c5a0e86e5da8732b75666d69` | Exact source used to generate deterministic bundle |
| **Dashboard** | `tester3x/wellbuilt-dashboard` | `473935a34ea54e03932e7f6b0f80a80bc0705618` | `fix/dashboard-g018r1-release-integrity-20260922` | The exact candidate SHA is the checked-out Git HEAD and must be obtained with `git rev-parse HEAD`. It is intentionally not embedded in this committed manifest because the commit hash includes the manifest itself. | `D:\dev_dash-g018r1-release-integrity-20260922` (parent `09d174d5...` deriving from accepted parent `473935a3...`) |
| **WB-T** | `tester3x/wellbuilt-ticket` | `ed6db82e16daf3cff4a32a75700f2d0d7bdd13a1` | `release/wbt-pw-governed-fieldtest-20260921` | `691bcbcac1b4ad09a16e2df59a7bfa3cfcbd87ed` | `D:\dev_wbt-pw-governed-fieldtest-20260921` (1 ahead, sole parent `ed6db82e...`) |
| **WB-M** | `tester3x/wellbuilt-mobile` | `e2ea5f1d839c23526b4b259594a86cad5943f06e` | `release/wbm-pw-governed-fieldtest-20260921` | `112799b2d83f1f3c5f7aac5a50c9ea497cd047d7` | `D:\dev_wbm-pw-governed-fieldtest-20260921` (1 ahead, sole parent `e2ea5f1d...`) |

### Versioning & Flag Invariants
- **WB-T**: `GOVERNED_PACKET_EXECUTION = true`, version `1.0.107`, Android versionCode `107` (agreed between `app.json` and `android/app/build.gradle`).
- **WB-M**: `GOVERNED_PACKET_ACCESS = true`, checked-in Android versionCode `59`, Expo version `2.1.0`, iOS buildNumber `24`.
  - *EAS Versioning Note*: `eas.json` specifies `appVersionSource: "remote"` and `autoIncrement: true`. EAS cloud builds ignore the local checked-in `versionCode` in `app.json` unless explicitly synchronized. Pre-build verification of remote EAS state (`eas build:version:get`) is **REQUIRED** prior to launching an automated cloud build.

---

## 2. Deterministic Contracts 0.7.0 Bundle Provenance

- **Source Repository**: `tester3x/wellbuilt-contracts`
- **Accepted Source SHA**: `a46e91e20227ebb2c5a0e86e5da8732b75666d69` (tag `v0.7.0`)
- **Pack Environment**: Node `v24.18.0`, npm `11.16.0`
- **Pack Configuration**: Built via package `prepack` (`tsc -p tsconfig.json`) and packed via `npm pack --json`.
- **Tarball Filename**: `tester3x-wellbuilt-contracts-0.7.0.tgz`
- **Committed Repository Location**: `functions/vendor/tester3x-wellbuilt-contracts-0.7.0.tgz`
- **Tarball File Size**: 163,734 bytes
- **Tarball SHA-256**: `84AC379FFB121CB1BA151CA0B950BA07C30BBCF5881FB92775B5C43EA0348DE3`
- **Unpacked Verification**:
  - Name: `@tester3x/wellbuilt-contracts`
  - Version: `0.7.0`
  - Root module exports: 237
  - Transport module exports: 105 (including `definitionSchema`, `resolveExecutionBinding`, `stampDispatchBinding`)
  - Contains zero PATs, `.npmrc` files, `.env` files, or private keys.

---

## 3. Clean-Environment Installation Proof

- **Test Setup**: Disposable temporary directory, fresh isolated npm cache (`npm_config_cache`), empty npm configuration (`npm_config_userconfig`), and all credential environment variables (`NODE_AUTH_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`) completely removed.
- **Lockfile-Native Installation**: `npm ci` completed in 4s adding 495 packages with zero vulnerabilities.
- **Registry Requests**: Zero requests to `npm.pkg.github.com` for Contracts.
- **Lockfile Invariance**: `functions/package-lock.json` was bit-for-bit identical before and after installation.
- **Compilation & Typecheck**: `npx tsc` and `npx tsc --noEmit` executed cleanly with exit code 0.
- **Runtime Import**: Node ESM dynamically imported `@tester3x/wellbuilt-contracts` (237 exports) and `@tester3x/wellbuilt-contracts/transport` (105 exports).
- **Lockfile Audit**: Search across `functions/package-lock.json` confirmed zero hits for `npm.pkg.github.com`, `ghp_`, `_authToken`, machine-specific absolute paths, or unauthorized Contracts versions.

---

## 4. Firebase Source-Bundle Inclusion Proof

- **Controlling Mechanism**:
  - The authoritative deploy-bundle control is **`firebase.json` → `functions.ignore`**.
  - `firebase.json` ignore list excludes `node_modules`, `.git`, `.npmrc`, `.env`, log files, and credential dumps. It does **NOT** ignore `vendor/` or `vendor/*.tgz`.
  - The vendored tarball `functions/vendor/tester3x-wellbuilt-contracts-0.7.0.tgz` is therefore included in the Firebase Functions upload bundle.
  - **`.gcloudignore` Truth**: `functions/.gcloudignore` is documentary/supplementary only. `firebase-tools` does NOT consult `.gcloudignore` for Cloud Functions packaging; packaging behavior is governed solely by `firebase.json` `functions.ignore`.
- **Local Packaging Verification**:
  - Archive-relative path: `vendor/tester3x-wellbuilt-contracts-0.7.0.tgz`
  - Included file size: 163,734 bytes
  - SHA-256 before & after packaging analysis: `84AC379FFB121CB1BA151CA0B950BA07C30BBCF5881FB92775B5C43EA0348DE3`
  - Excluded from bundle: `node_modules`, `.npmrc`, `.env`, and rules files.

---

## 5. Stale Mirror Census & Resolution

- **Census**:
  - `functions/contracts-mirror/` was found to be stale Contracts 0.4.0 (missing the entire `./transport` export required by Dashboard runtime code).
  - No runtime code in `src/` or `functions/src/` imported from `contracts-mirror`.
  - Only references were the stale generator `functions/tools/mirror-contracts.mjs` and the `test:sso` script.
- **Resolution**:
  - Atomically removed `functions/contracts-mirror/` and `functions/tools/mirror-contracts.mjs`.
  - Removed `node tools/mirror-contracts.mjs --verify` from `functions/package.json` `test:sso`.
  - Removed `functions/.npmrc` since `@tester3x/wellbuilt-contracts` was the sole `@tester3x` package in Functions.
  - Eliminated duplicate mirror implementations: the committed tarball `functions/vendor/tester3x-wellbuilt-contracts-0.7.0.tgz` is the single authoritative source.

---

## 6. Tenant-Dependent Content Hash Rule & Proof

### Architectural Truth
- `contentHashMaterial` includes `companyId` (as defined in `jobPacketRevisionStore.ts`).
- Therefore, **`contentHash` is tenant-dependent** and CANNOT be predetermined while the field-test company ID remains an unresolved placeholder.
- In contrast, **`policyHash` is tenant-independent** and depends only on `policyRefs`. For the base Production Water packet (which has `policyRefs: []`), `policyHash` is canonically `74d37a6a02553c623cd3a90dbd12eefbc2dccdc8c2f7e5fb9f14e56112b39d5e`.
- **Publication Protocol**:
  1. Staff invokes `publishJobPacketRevision` with the base draft.
  2. The server computes `contentHash` and `policyHash` for the caller's authenticated company and stores the revision.
  3. The client captures the returned `contentHash` and verifies the stored revision.
  4. At dispatch creation, caller supplies ONLY `packetRef: { packageId: "water-hauling", revision: 1 }`.
  5. The server loads the stored revision, verifies hashes, and derives all four pins via `stampDispatchBinding`.
  6. Callers never supply `contentHash`, `policyHash`, or `status`.

### Independent Multi-Tenant Proof
Executed against `runPublishJobPacketRevision`, `validateStoredRevisionForBinding`, and `stampDispatchBinding`:
- **Tenant A (`company-alpha`)**:
  - `contentHash`: `2db21881d82c6e1a9650beeb1b2eebec57884398123d1aa49216851a0d8f7fa0`
  - `policyHash`: `74d37a6a02553c623cd3a90dbd12eefbc2dccdc8c2f7e5fb9f14e56112b39d5e`
- **Tenant B (`company-bravo`)**:
  - `contentHash`: `c9a0091719152baad25e2d7495e063a5c5798bd0f38e9ac0c29ba2bf882711b8`
  - `policyHash`: `74d37a6a02553c623cd3a90dbd12eefbc2dccdc8c2f7e5fb9f14e56112b39d5e`
- **Tenant C (`liquid-gold`)**:
  - `contentHash`: `57cc9790ddf517d43d7343e2952788e25c7916a6eee955e73ec6916175df5287`
  - `policyHash`: `74d37a6a02553c623cd3a90dbd12eefbc2dccdc8c2f7e5fb9f14e56112b39d5e`
- **Findings**:
  - Content hashes differ across tenants (`alpha !== bravo !== liquid-gold`).
  - Policy hashes are 100% identical across all tenants (`74d37a6a...`).
  - All revisions validate and bind cleanly via `stampDispatchBinding` and `verifyDispatchPinsAgainstEnvelope`.

---

## 7. WB-M Submission Path Census

Traced from WB-M release tip `112799b2d83f1f3c5f7aac5a50c9ea497cd047d7`:
1. `/record?jobId=...` resolves context via `authorizeGovernedPullSubmit(jobId)` (`resolveExecutionBinding`).
2. Authoritative well name displayed; driver inputs tank level and barrels.
3. On Submit (`handleSubmit`), client invokes `smartUploadTankPacket` -> `uploadTankPacket` -> `secureIngestPacket`.
4. `secureIngestPacket` calls HTTPS onCall v2 callable **`ingestWbmPull`**.
5. Server `ingestWbmPull` validates caller driver authority and profile, rate-limits, and writes the stamped pull payload to RTDB path `packets/incoming/{storageKey}`.
6. RTDB trigger **`processIncomingPull`** fires on `packets/incoming/{packetId}`, updates well levels and status, writes history to `wells/{wellName}/runs`, writes `packets/processed/`, updates `canonical_jobs`, and bumps `incoming_version`.
7. **Production Deployment Census**:
   - `ingestWbmPull`: **PRESENT IN PRODUCTION METADATA** (GCF v2, Node 20, us-central1; confirmed in G-016A `functions-ids.txt` line 98; live source equality is unproven without authorized production preflight).
   - `processIncomingPull`: **PRESENT IN PRODUCTION METADATA** (GCF v1, Node 20, us-central1; confirmed in G-016A `functions-ids.txt` line 129; live source equality is unproven without authorized production preflight).
   - Neither function is modified or requires re-deployment for this field test.

---

## 8. Revalidated Named Functions Deployment & Strict Deploy Guard

### Deploy Guard (MANDATORY ABORT CONDITIONS)
**ABORT** immediately if any deployment command includes:
- `--only firestore`
- `--only database`
- Any rules file (`firestore.rules`, `database.rules.json`, `database.rules.secure.json`)
- Unfiltered `firebase deploy`

### A. Minimum PW Field-Test Functions (7 Callables — UNEXECUTED)
```bash
firebase deploy --project wellbuilt-sync --only functions:publishJobPacketRevision,functions:staffWriteDispatch,functions:acceptDriverDispatch,functions:resolveExecutionBinding,functions:adminGetDashboardCatalog,functions:adminGetWellPool,functions:dismissDispatch
```

| Function Name | Field-Test Step | Authority Required | Status / Deployment Scope | Rollback / Recovery Procedure |
|---|---|---|---|---|
| `publishJobPacketRevision` | Step 1 (Publish packet rev 1) | Trusted Staff (`manageDrivers`) | NEW CALLABLE | Delete newly introduced callable |
| `staffWriteDispatch` | Step 2 (Create pinned dispatch) | Trusted Staff (`manageDrivers`) | MODIFIED / REPLACES LIVE | Redeploy captured prior live version |
| `acceptDriverDispatch` | Step 3 (Driver accepts dispatch) | Assigned Driver (`driverId`) | MODIFIED / REPLACES LIVE | Redeploy captured prior live version |
| `resolveExecutionBinding` | Step 4 (Client resolves context) | Assigned Driver (`driverId`) | NEW CALLABLE | Delete newly introduced callable |
| `adminGetDashboardCatalog` | Preflight / Step 2 (Staff UI roster) | Staff / Admin | PRESENT IN PRODUCTION; REDEPLOYED TO REBUILD ON 0.7.0 BUNDLE | Redeploy captured prior live version |
| `adminGetWellPool` | Preflight / Step 2 (Well selector) | Staff / Admin | PRESENT IN PRODUCTION; REDEPLOYED TO REBUILD ON 0.7.0 BUNDLE | Redeploy captured prior live version |
| `dismissDispatch` | Step 8 / Post-Test Teardown | Staff (`manageDrivers`) / Driver | MODIFIED / REPLACES LIVE | Redeploy captured prior live version |

*Deployment Scope & Recovery Classification*:
- **NEW CALLABLE**: Introduced in this release; did not exist in production prior to deployment. Recovery is deleting the newly created Function (`firebase functions:delete` or GCP Console).
- **MODIFIED / REPLACES LIVE**: Function exists in production and accepted source contains modified/updated implementation. Recovery requires redeploying the exact captured prior version.
- **PRESENT IN PRODUCTION; REDEPLOYED TO REBUILD ON 0.7.0 BUNDLE**: Function presently exists in production metadata, but is included in the 7-set deployment command to ensure its runtime environment rebuilds against the vendored Contracts 0.7.0 bundle.
- **LIVE SOURCE EQUALITY**: The exact source code currently running in production is UNKNOWN without authorized preflight. Do not assume "already deployed" means the accepted candidate source is already live.

### B. Optional Staff/Admin Support Functions (12 Callables — UNEXECUTED)
```bash
firebase deploy --project wellbuilt-sync --only functions:createDriverDispatchIfAbsent,functions:staffWriteWellConfig,functions:staffWriteDriverAssignment,functions:adminGetWellHistory,functions:adminGetWellPerformance,functions:getCompanyJoinCode,functions:rotateCompanyJoinCode,functions:adminBindDriverCompany,functions:inviteEmployee,functions:staffWriteUserRoles,functions:staffWriteRoleCapabilities,functions:staffWriteDriverRoster
```

---

## 9. Trusted-Authority Provisioning & State-Preserving Rollback (UNEXECUTED)

Target Document: `trusted_staff_authority/{staffUid}`
Record Schema (Exact 5 keys, no `_comment`):
```json
{
  "schemaVersion": 1,
  "uid": "<staffUid>",
  "companyId": "<companyId>",
  "active": true,
  "capabilities": ["manageDrivers"]
}
```

### Procedures:
1. **Preflight Read**: Read `trusted_staff_authority/<staffUid>` via Admin SDK. Validate document exists, `active === true`, `uid === <staffUid>`, and `capabilities` contains `manageDrivers`.
2. **Create / Minimal Update**: Write exact 5 fields above via Firebase Admin SDK. Document ID must strictly equal `staffUid`.
3. **Verification**: Re-read document through `parseTrustedStaffAuthorityRecord`. Confirm `ok === true` and zero extraneous fields (extraneous keys fail with `reason: "trusted_authority_malformed"`).
4. **State-Preserving Rollback**:
   - Step 1: Pre-test read captures existence status (`exists: boolean`).
   - Step 2: If record existed, preserve full prior document data.
   - Step 3: If record did NOT exist prior to test: issue Admin SDK `delete()` against `trusted_staff_authority/<staffUid>`.
   - Step 4: If record existed prior to test: issue Admin SDK `set()` restoring original preserved document data.
   - Step 5: Post-rollback verification read confirms document matches exact pre-test state.

---

## 10. Truthful Rollback Strategy

- **Dashboard Local Source**: Leave `fix/dashboard-g018r1-release-integrity-20260922` unmerged.
- **WB-T Source**: Revert to accepted parent commit `ed6db82e16daf3cff4a32a75700f2d0d7bdd13a1` (flag OFF, VC106).
- **WB-M Source**: Revert to accepted parent commit `e2ea5f1d839c23526b4b259594a86cad5943f06e` (flag OFF, no android.versionCode).
- **Functions Rollback (CRITICAL OPERATIONAL TRUTH)**:
  - The exact source version currently deployed in production is **UNKNOWN** (no production reads or preflight inspection have been performed in this local lane).
  - Commit `473935a34ea54e03932e7f6b0f80a80bc0705618` is the accepted **NEW base** of this release, NOT the prior-live production version. Redeploying `473935a3` would NOT restore the prior live state.
  - **Rollback for Existing Functions**: For functions that already existed in production prior to deployment (`staffWriteDispatch`, `acceptDriverDispatch`, `adminGetDashboardCatalog`, `adminGetWellPool`, `dismissDispatch`), rollback requires capturing their exact prior deployed source/image during authorized production preflight and redeploying that captured prior version (or rolling back Cloud Run revision traffic where supported; note GCF v1 functions like `processIncomingPull` do not support revision traffic splitting).
  - **Rollback for Newly Introduced Functions**: For callables introduced by this release (`publishJobPacketRevision`, `resolveExecutionBinding`), rollback means **DELETING** the newly created functions via `firebase functions:delete` or GCP Console.
  - **Mandatory Preflight Requirement**: Deployment must **ABORT** if authorized production preflight cannot capture the exact prior live state and establish a safe recovery/rollback procedure for every named Function.
  - This local source repair performs zero production preflight and zero deployment.
- **Authority**: Execute 5-step state-preserving rollback on `trusted_staff_authority/<staffUid>`.
- **Rules**: Live rules were never modified; no rules rollback needed.

---

## 11. Production Facts Census

- **Project ID**: `wellbuilt-sync` (Project # `559487114498`)
- **Functions Region / Runtime**: `us-central1`, GCF v2, Node.js 20
- **Live Rules**: Firestore and RTDB live rules are strictly denied root / client-write; repository rules must not be deployed.
- **UNKNOWN Production Facts**:
  - Existence and contents of `trusted_staff_authority/{staffUid}`: **UNKNOWN** (no production reads performed).
  - Field-test staff UID and company ID: **UNKNOWN** (placeholders preserved).
  - Field-test driver UID and hash: **UNKNOWN** (placeholders preserved).
  - Authorized production field-test well name / NDIC well name: **UNKNOWN** (placeholders preserved).
  - Remote EAS build version counter for Android: **UNKNOWN** (requires remote service query `eas build:version:get`).

---

## 12. Actions Still Requiring Mike's Explicit Authorization

1. Modification of production `trusted_staff_authority` documents.
2. Deployment of any Cloud Functions to `wellbuilt-sync`.
3. Execution of `publishJobPacketRevision` against production Firestore.
4. Creation of live dispatches in production.
5. Querying or altering EAS remote build counters.
6. Triggering EAS cloud builds for mobile binaries.
7. Tagging or merging release branches into main.
