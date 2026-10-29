FIRST: Read D:/dev/workspace-control/POLICY.md in full before taking action. Then read the assigned repository's applicable AGENTS.md and CLAUDE.md. Follow the current user-authorized workspace policy over obsolete task notes.

# Laptop handoff: canonical DVIR upload review

The laptop cannot be assumed to access the desktop D: drive. The full current desktop policy follows this packet. Desktop lease commands apply only on this PC; the laptop must use its own registered checkout and report its actual environment.

## Assignment

- Recipient: laptop WB eQuipment Codex, reported session `01a139b5-d3f7-7401-bdf0-3443ec841c28`.
- Environment and existing checkout reported by laptop: `C:/dev/TicketTimeExpo/tmp/wbe-shop-20261012`.
- Assigned repository and verified GitHub remote: `tester3x/wellbuilt-equipment`, `https://github.com/tester3x/wellbuilt-equipment.git`.
- Branch/base: `codex/wbe-shop-20261012`; GitHub handoff HEAD `0e3a194184d1078145109886cb6196925389dbf7`, following app implementation `3cd4b750374eb467ccb492b231661e7a321cd08a`. Verify the laptop's current local branch, HEAD, dirty files and remote before edits; these GitHub values do not establish the laptop's current checkout state.
- Desktop source: `D:/dev/Dashboard`, `https://github.com/tester3x/wellbuilt-dashboard.git`, `release/dashboard-current-20260927`, source checkpoint `cd7f4449a9eadec220e7a8f26fa743fdd9413132` before this documentation handoff. Desktop owns this repository; laptop must not edit it.
- Objective: preserve app-side canonical upload behavior and report any true app-only mismatch after comparison with desktop source. No APK release or live backend deployment is assigned by this packet.
- Scope: WB eQuipment app canonical DVIR upload, its injected transport tests, and its existing handoff document. User authorized continued desktop/laptop collaboration and scoped source work. One app writer only; claim the registered app home before edits. Do not create another checkout or bypass a conflicting owner.

## Desktop review of laptop return

I read `docs/LAPTOP-DVIR-REPORT-UPLOAD-RETURN-20261029.md` at GitHub HEAD `0e3a194184d1078145109886cb6196925389dbf7` and compared the pushed `canonicalDvirReportSync.ts`, `canonicalDvirReportRuntime.ts`, and `canonicalDvirReportSources.ts` at `3cd4b750374eb467ccb492b231661e7a321cd08a` to the staged Dashboard callables and report contract at `cd7f4449a9eadec220e7a8f26fa743fdd9413132`.

- Callable names and `us-central1` region match. Capability request/reply and full report request/receipt fields match. The app verifies company, IDs, phase, version, digest and private Firestore path before acknowledgement.
- The app and server both sort object keys and hash UTF-8 canonical JSON. The app removes undefined object properties; its upload copy has JSON-safe data. The 800000-byte bound matches. Array order remains intact.
- The app retains the original signed report and checks account ownership on queue, call and receipt operations. It sends both real signed phases separately and does not invent a pre-trip.
- A report with a local defect photo remains local and retryable. The current server also rejects `remoteEvidenceId`, while the app would attempt submission with such an ID if no `localDraftRef` remains. This is an unresolved media ownership contract, not an acknowledgement risk: the server rejects it. Preserve photos and queued reports. Do not fabricate an opaque remote ID or make the server accept one without a verified private ownership record.
- Historical shift ownership remains unverified server-side. Profile provenance is validated against a published revision, but this is not a phone-to-backend integration result.
- Full-report ingestion stays disabled by default (`WB_EQUIPMENT_FULL_DVIR_ENABLED` is not true); Dashboard viewer stays disabled by default. No Functions/Hosting/CORS deployment or live report round trip has been verified. The user-reported E107 installation was not replaced in this review.

## Next laptop work and acceptance

1. Confirm the current app source still matches the reviewed `3cd4b750` transport. If it moved, compare changed lines before relying on this review. Keep the complete signed graph and receipt checks.
2. Inspect an actual app-produced report fixture or locally sealed report for `driver.driverHash`, `signature.signerId`, `reportId`, version/amendment, `assetSections`, and profile provenance. Compare it to `functions/src/equipment/reports/reportContract.ts` and `callables.ts` at desktop source checkpoint. Return exact field/value mismatches with a redacted fixture; do not change signed records to satisfy a guess.
3. Identify any existing remote defect evidence identifier, its private storage path, and authoritative owner binding. If no such transport exists, state that explicitly and keep photo reports queued.
4. Run the relevant app transport tests/typecheck after any app change. Commit/push scoped work under the laptop's registered claim after reconciling current GitHub state. No APK build/install from this handoff.

## Required return

Report actual laptop checkout, remote, branch, starting/final HEAD, changed files, tests/results, account/identity fixture findings, defect media ownership format, remaining blockers, lease disposition, and exact committed/pushed/built/installed/deployed/verified state. Preserve unrelated work. Do not claim live integration from injected tests.

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
