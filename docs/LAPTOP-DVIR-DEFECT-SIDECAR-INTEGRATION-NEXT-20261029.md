FIRST: Read D:/dev/workspace-control/POLICY.md in full before taking action. Then read the assigned repository's applicable AGENTS.md and CLAUDE.md. Follow the current user-authorized workspace policy over obsolete task notes.

# Laptop handoff: private DVIR defect photo sidecar source

The laptop may not have the desktop D: drive. The full current desktop POLICY.md is copied below. Desktop lease commands apply only on this PC; use the laptop's own registered checkout and report its actual environment.

## Assignment

- Recipient/owner: laptop WB eQuipment Codex, reported session `01a139b5-d3f7-7401-bdf0-3443ec841c28`.
- Environment and existing checkout reported by laptop: `C:/dev/TicketTimeExpo/tmp/wbe-shop-20261012`.
- Assigned repository/remote: `tester3x/wellbuilt-equipment`, `https://github.com/tester3x/wellbuilt-equipment.git`.
- Verified GitHub branch/base: `codex/wbe-shop-20261012` at `88f0920f91d79248fcdea56a42c3e32486bb6cf0` on 2026-10-29. Verify the laptop's actual branch, HEAD, dirty files, owner and freshly fetched remote before editing; this is a remote fact, not local laptop verification.
- Desktop repository/home/remote: `D:/dev/Dashboard`, `https://github.com/tester3x/wellbuilt-dashboard.git`, branch `release/dashboard-current-20260927`, pushed source checkpoint `f9546257088bba3f15956cecddff78535bb563d0`. Desktop is its sole writer; laptop must not edit it.
- Objective: implement the app side of the private defect-photo flow against the staged server source, preserving signed report bytes and offline data. User authorized continued scoped desktop/laptop DVIR work. This packet authorizes app source/tests/commit/push in its registered home, not an APK build/install or any live deployment/data/CORS/rules change.
- Dependencies: server source exists but is disabled by both `WB_EQUIPMENT_FULL_DVIR_ENABLED` and `WB_EQUIPMENT_DEFECT_EVIDENCE_ENABLED`; no live Functions/CORS change occurred. The app can test with injected transport and real local file storage without claiming live round-trip success. If another app writer owns the registered home, coordinate; do not create a checkout or bypass the claim.

## Desktop response to the laptop proposal

Accepted the signed-local-reference plus verified sidecar design. The signed `dvir-report/2` JSON remains unchanged after signing; receipt IDs live outside it. No arbitrary `remoteEvidenceId`, old placeholder, URI, or legacy imported string is proof of private ownership. Current no-photo reports retain their existing transport. There is no report schema bump; the additive `defectEvidence` capability negotiates the new path.

Source-only server changes at `f9546257088bba3f15956cecddff78535bb563d0`:

- New `us-central1` callables `beginEquipmentInspectionEvidenceUpload`, `finalizeEquipmentInspectionEvidence`, and Dashboard-only `getEquipmentInspectionEvidenceReadUrl`. The canonical driver/company comes from the active session. New records and Storage paths are scoped under `companies/<companyId>/equipment_inspection_evidence` and `companies/<companyId>/equipment-inspection-evidence/<canonicalDriverId>/` respectively. These are opaque server-derived paths, not app write authorities.
- A signed report may contain **one** JPEG photo per issue, max 8 MiB each, 20 photos/80 MiB per report. Evidence inside the signed report must be `{localDraftRef:<safe opaque ID>,sha256:<64 lowercase hex>,byteLength:<positive integer>,contentType:'image/jpeg',caption?:string}`. The localDraftRef is an opaque ID, never an absolute URI. It and the hash/size/type are part of the original signed report digest. Preserve the original bytes privately on device.
- `getEquipmentInspectionReportCapabilities({schemaVersion:1})` adds `defectEvidence:{schemaVersion:1,mode:'owned-sidecar',maxPhotosPerReport:20,maxTotalBytes:83886080,maxPhotoBytes:8388608,contentTypes:['image/jpeg']}` only when both server flags are on. Missing capability means keep photo reports local.
- Begin request: `{schemaVersion:1,reportIdentity:{inspectionId,inspectionType,reportId,version},reportDigest,issueId,areaId,itemId,localEvidenceId,sha256,byteLength,contentType:'image/jpeg'}`. Reply: `{schemaVersion:1,companyId,driverId,evidenceId,binding,upload:{url,expiresAt,method:'PUT'}}`. Exact repeated begin returns the same `e_<64hex>` evidence ID and a fresh 10-minute URL. Distinct bindings get distinct IDs. Server caps new reservations at 100 per driver per UTC day.
- PUT exactly the captured JPEG bytes to the returned short-lived URL with `Content-Type: image/jpeg`, `x-goog-if-generation-match: 0`, and `x-goog-meta-sha256: <hash>`. A lost response or generation precondition error must attempt finalize/read verification, not overwrite.
- Finalize request: `{schemaVersion:1,evidenceId}`. Reply: `{schemaVersion:1,companyId,driverId,evidenceId,receiptId:evidenceId,state:'verified',binding}`. Server checks object MIME, size, SHA-256, JPEG magic bytes, generation and owner. Exact repeat is idempotent. Retain a verified receipt outside the signed report, owner scoped, across restarts.
- Submit the **unchanged** signed report with `{schemaVersion:1,report,reportDigest,evidenceReceiptIds:[...]}` only when all signed local references have verified matching receipts. Server checks exact company/driver/report digest/phase/version/issue/area/item/local ID/hash/size/type coverage within the report transaction. Missing, extra, unverified or substituted receipts reject; no false sync. Report receipt stays the existing `submitEquipmentInspectionReport` shape.
- Dashboard detail returns `verifiedEvidence` mapping and an authorized read callable issues temporary GET URLs. No public token or direct Storage permissions were added.

## Laptop implementation and checks

1. Replace the explicit placeholder action with a real optional camera/library flow. Pin/check the ArtifactLease around native UI and every async file step. Stage, hash, validate and copy JPEG bytes to durable owner-scoped app-private document storage before placing the opaque ID in a draft. Cancel/failed copy/account switch must not attach a false photo.
2. Extend domain EvidenceRef and the engine projection so sha256 and byteLength survive draft, signed report and restart. Existing signed reports are immutable; do not migrate placeholders by inventing bytes or silently re-sign. Keep files while referenced by drafts, sealed phases, archived replacements or pending uploads.
3. Add capability-aware begin/PUT/finalize and owner-scoped receipt storage. Then submit the original signed report with the verified receipt IDs. A missing capability, absent/corrupt local file, unsupported old placeholder, error or timeout leaves the report and photo local/retryable; no `remoteEvidenceId` fallback and no direct Firestore/public URL path.
4. Test cancel/permissions/account switch, offline restart, hash/size mismatch, begin/finalize lost reply and exact retry, 412/generation-zero recovery, phase/version/issue substitution, incomplete receipt coverage, unchanged signed digest, old placeholder behavior and no-photo behavior. Run typechecks. Commit/push scoped source after GitHub reconciliation.

## Desktop state and remaining prerequisites

Desktop Functions TypeScript build passed. Focused report/callable Jest: 2 suites, 13 tests passed, including disabled capability, authority, binding, upload reservation/finalize, verified receipt coverage, substitution and idempotency. These use mocked Admin SDK/Storage and are not live Firebase tests. No Functions, Hosting, bucket CORS, rules, app, APK or customer data changed live. The previously installed E107 is separate from this source.

Before enabling either server flag or deploying, desktop still needs emulator/isolated real endpoint and Storage tests, live CORS verification for signed PUT headers, pending-object expiry/cleanup policy, historical shift association decision and a scoped release review. No build/deployment is authorized by this handoff.

## Required return

Report actual laptop checkout/remote/branch/starting and final HEAD, claim disposition, changed files, tests and evidence, exact app transport behavior, blockers, and distinct committed/pushed/built/installed/deployed/verified state. Return any precise server mismatch with a redacted fixture. Preserve unrelated work and signed reports.

## Full desktop POLICY.md (mandatory copy for cross-computer recipient)

# Workspace operating rules — 2026-09-26, amended 2026-10-01

The user requires one registered home per repository and no recurring checkout sprawl.

- Before modifying a local repo, read D:/dev/workspace-control/registry.json and claim it with: node D:/dev/workspace-control/guard.cjs claim "REPO" "SESSION-ID" "TASK". Use your real chat/session ID. One writer per repository. Read-only review needs no claim.
- Work in the registered home. Never create clones, worktrees, temporary source copies, audit checkouts, or build checkouts as a routine workaround. If another task owns the repo, coordinate or wait; do not create another folder.
- The user's explicit request for an isolated checkout is a maintenance exception: inspect existing checkouts, register its owner and purpose, and keep the active writer limit. Do not disable guards as a workaround. Codex-managed checkouts must use the app lifecycle tools.
- Archived worktrees are recovery material, not additional active repos. Recover through D:/dev/workspace-control/archive.cjs restore "ORIGINAL_PATH" and deliberately register the resumed checkout before editing.
- Before editing, verify remote, branch, HEAD, and existing dirty files. Preserve pre-existing work. Do not switch branches underneath an active task, reset hard, force-push, clean away untracked files, or auto-commit someone else's edits.
- When the registry contains acceptedSource, every write checkout must contain that exact accepted commit in its ancestry. The guard checks this on claim, edit checks, commit, and push. Older branches remain recovery history; do not lower or remove the accepted baseline to resume stale code. A different baseline requires an explicitly authorized reconciliation with preservation and verification.
- Before handoff, preserve your scoped work and record its disposition. Run guard.cjs finish "REPO" "SESSION-ID" once ready. Unfinished tasks retain their ownership; never silently steal or expire a lease.
- For user-requested code repairs and releases, carry the work through the applicable commit, push, build submission, scoped deployment, installation, and verification steps without asking again solely because the work has reached a release stage. There is no blanket do-not-deploy, do-not-submit, or do-not-push rule. Verify the exact source commit, project/app, resources, owner, full release delta, and required checks before publishing; preserve unrelated work and use only the authorized scope. Historical packets with narrower release bans describe their old assignments and do not block later user-authorized work.
- Repository home, integration branch, build source, installed app, and live deployment are separate facts. Do not declare them equal without evidence.
- Never delete or retire checkouts because they are merely clean, old, merged, or idle. Preserve local-only commits, dirty/untracked/ignored data, registered worktree links, and recoverability.
- New projects require explicit registration; do not scatter new repositories across drive roots or temp directories.

Executable enforcement is documented in D:/dev/workspace-control/README.md. The local hooks and agent rules are guardrails, not OS isolation: do not bypass them through alternate shells, scripts, APIs, hooks overrides, or other tools.
## Project director: mandatory AI packet contract

The project director owns task framing and must include these instructions in every AI assignment, handoff, repair packet, and audit packet. Never assume an AI has read another chat or remembers a prior packet.

1. Begin every local packet with: "FIRST: Read D:/dev/workspace-control/POLICY.md in full before taking action. Then read the assigned repository's applicable AGENTS.md and CLAUDE.md. Follow the current user-authorized workspace policy over obsolete task notes."
2. For a cloud AI or any recipient unable to access that file, include the FULL current contents of POLICY.md in the packet. A local path or an inaccessible link is not a substitute. Label local-only procedures; the cloud AI must use its existing platform checkout and report its actual environment rather than claim it acquired a local lease.
3. Identify the exact assigned repository and remote, execution environment, existing checkout, branch/base commit, task owner, and objective. Verify current values when preparing the packet; registry observedBranch/observedHead are historical inventory, not live facts. If a base cannot be verified, start the task with read-only discovery and require that uncertainty to be resolved before edits.
4. State the task's scope, actions already authorized by the user, dependencies, and acceptance criteria. Carry forward standing authorization rather than repeatedly asking the user. Do not grant a worker broader merge, push, deployment, data-change, or cross-repository authority than the user has granted.
5. For local edits, require the ownership claim before writing. Assign only one writer per repository; audits are read-only unless corrections are explicitly assigned. Do not dispatch overlapping writers or use extra clones/worktrees to avoid coordination. Do not create or message other chats without the user's applicable authorization.
6. Require a return with actual checkout/remote/branch/HEAD, changed files, relevant checks and results, preserved outstanding work, and the exact committed/pushed/built/installed/deployed/verified state applicable to the task. Require evidence for acceptance criteria, not an unsupported "done."
7. Evaluate the returned evidence before authorizing dependent work or declaring completion. Unverified claims remain unverified. End a local write task by preserving scoped work, recording its disposition, and releasing its lease when safe.
8. If the worker cannot read the instructions, cannot verify repository identity, finds another owner, or encounters conflicting state, it should preserve the work and report the specific blocker. It must not improvise another checkout or bypass a guard.

Use D:/dev/workspace-control/PACKET-TEMPLATE.md when preparing packets. Populate its fields from verified evidence; never send unresolved template placeholders as an executable assignment. This contract applies to packets prepared in chat as well as saved packet files. Do not send this policy itself as an instruction to begin new application work.

## Mandatory cross-computer build reconciliation — user amendment2026-10-27

Before any desktop or laptop release build: commit/push scoped work; freshly fetch all relevant GitHub branches/tags; identify the other machine's commits and reconcile them into the intended release branch preserving both features. Verify expected commit ancestry, inspect the full release delta, run relevant checks on combined source, and push final reconciled HEAD. Build exact committed clean source in the registered home; re-fetch and verify remote movement immediately before building. No blind reset, force push or extra checkout. Unpushed other-machine work cannot be discovered and must be reported as a limitation, never called synchronized.

Allocate versionCode above published/cloud AND local manifest/APK/remote reservation/user-reported installed evidence for the same package. EAS history omits local SDK builds. User reports WB-T274 on ZFold, WBE98 and WBS100 are known minimum evidence, not independent device readback. Preserve package ID/signing certificate. One release owner across machines; verify an immutable GitHub reservation before build. Where no coordinated lock exists, use non-force annotated Git tag android-release-vN as an atomic same-version reservation; never overwrite/delete consumed reservations. This is not an exclusive server-wide release lock. Record source/version/package/signing SHA256/build method/APK SHA256 durably on GitHub without secrets.

WB-M and WB-T carry portable instructions/gates at docs/android-release-reconciliation.md and scripts/release-preflight.cjs. Those files must accompany laptop handoffs. Current task authorization remains authoritative; these rules do not authorize cloud builds, new app features, APK replacement, installs or live data changes.
