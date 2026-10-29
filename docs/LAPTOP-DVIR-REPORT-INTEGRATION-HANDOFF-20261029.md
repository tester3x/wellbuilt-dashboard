FIRST: Read D:/dev/workspace-control/POLICY.md in full before taking action. Then read the assigned repository's applicable AGENTS.md and CLAUDE.md. Follow the current user-authorized workspace policy over obsolete task notes.

# Laptop handoff: full DVIR report transport checkpoint

The laptop cannot be assumed to access the desktop D: drive, so the complete current desktop policy is copied below. Desktop lease commands in that policy are local to the desktop PC. The laptop must follow its own registered-home/lease procedures and report its actual environment.

## Assignment

- Owner: laptop WB eQuipment Codex, session `01a139b5-d3f7-7401-bdf0-3443ec841c28` according to its new desktop packet. Preserve any current laptop lease and work; do not have a second app writer.
- Laptop environment/registered checkout reported in that packet: `C:/dev/TicketTimeExpo/tmp/wbe-shop-20261012`; repository remote `https://github.com/tester3x/wellbuilt-equipment.git`; branch `codex/wbe-shop-20261012`. GitHub `ls-remote` returned `cfd9d831c3acc398b2004411e577eb32adf9fd0f` on 2026-10-29. The packet reported its local base `d0f725fff2f904e3ccfd36723eece00a09e96c47`, which differs from the remote head; **start read-only** and verify actual laptop HEAD, dirty files, and remote movement before editing. Do not reset or create a checkout.
- Desktop source: `D:/dev/Dashboard`, remote `https://github.com/tester3x/wellbuilt-dashboard.git`, branch `release/dashboard-current-20260927`, pushed source checkpoint `3bd3845980b2f15759a10becb96fd0d15b7d77ec` (full SHA verify via GitHub). Desktop owns this repository; laptop must not edit it.
- Objective: align laptop's queued `dvir-report/2` transport and receipt validation with the new Dashboard source contract; test injected transport and return exact mismatches and remaining server requests. User authorized continued cross-computer collaboration. This is app integration, not an APK release.

## Desktop source contract now staged and pushed

- New `us-central1` callables: `getEquipmentInspectionReportCapabilities({schemaVersion:1})` and `submitEquipmentInspectionReport({schemaVersion:1,report,reportDigest})`. Capability reply: `{schemaVersion:1,companyId,enabled,reportSchemaVersion:'dvir-report/2',supportsCombinedAssets:true,supportsProfileProvenance:true}`. `enabled` is false until a scoped backend release sets `WB_EQUIPMENT_FULL_DVIR_ENABLED=true`. Missing/disabled capability must keep phone reports local and retryable.
- Submit reply: `{schemaVersion:1,companyId,accepted:true,inspectionId,reportId,inspectionType,version,reportDigest,storagePath}`. `storagePath` is the opaque Firestore document path `companies/<companyId>/equipment_inspection_reports/<r_64hex>`; it is not a media URL. Receipt must be matched by the app before local acknowledgement.
- Digest: omit undefined object properties through JSON serialization, recursively sort object keys with JS lexical `.sort()`, preserve array order, `JSON.stringify`, SHA-256 UTF-8 lower hex. Server bounds canonical JSON to 800000 bytes and verifies digest independently.
- Server derives driver/company from active canonical driver authority; checks report driver and signer against that identity, validates the frozen asset/area/item/issue graph, signature acknowledgement, optional exact historical published profile media, and stores the complete report immutably. Idempotency includes canonical company/driver, inspectionId, inspectionType, reportId, and version. Same identity/digest returns same receipt; changed digest conflicts. Existing nine-category route remains untouched.
- Dashboard has optional `listEquipmentInspectionReports` and `getEquipmentInspectionReport` callables and a complete-report viewer behind `NEXT_PUBLIC_DVIR_FULL_REPORTS_ENABLED=true`. It is off by default.
- **No Functions/Hosting/CORS/defaults/APK or customer data were deployed or changed live.** Source builds and focused tests pass. The app cannot call these endpoints live yet.

## App-side work and limits

1. Compare the laptop queue's canonical serializer, 800000-byte bound, callable names/region/request/reply fields, missing-capability behavior, and receipt identity checks against the staged Dashboard contract. Run injected transport tests for lost reply/retry, changed-body conflict, pre/post sharing inspectionId, combined assets, historical profile revision, and disabled capability. Fix app-only mismatches under the existing laptop ownership claim; commit/push scoped work after fresh GitHub reconciliation.
2. Check the app's actual `driver.driverHash` and `signature.signerId` values. Dashboard currently accepts a canonical driver ID or verified legacy binding for driverHash, and requires signerId to match driverHash or canonical driver ID. Report any real app identity mismatch before altering the server contract.
3. The staged server currently rejects reports containing `localDraftRef` **or** `remoteEvidenceId` in defect evidence. Local-only evidence must remain retryable; remote evidence requires a separately verifiable ownership record, which is not yet defined. Do not falsely acknowledge such a report or delete local pictures. Return the app's existing remote evidence ID format and server ownership source if one exists so desktop can finish it.
4. The server validates `shiftId` as report content but does not yet prove historical shift ownership. Preserve existing Suite completion/shift behavior and identify any app-side expectation for that check.
5. Do not build/install an APK or claim phone round-trip success from this source. The backend capability is disabled and live CORS still lacks signed PUT headers. The desktop checkpoint and smallest additive CORS plan are in `docs/dvir-full-report-and-cors-checkpoint-20261029.md` at Dashboard commit `3bd3845980b2f15759a10becb96fd0d15b7d77ec`.

## Required return

Send a new desktop handoff in the established WB eQuipment docs/GitHub route after your app work. Include actual laptop checkout, remote, branch, starting/final HEAD, changed files, tests, current owner/lease disposition, exact transport behavior, digest/identity compatibility, remote evidence format, and committed/pushed/built/installed/deployed/verified state. Distinguish source tests from live integration. Do not send a handoff based on unpushed changes.

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
