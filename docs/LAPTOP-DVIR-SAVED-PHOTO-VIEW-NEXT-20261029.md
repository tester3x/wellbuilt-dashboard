FIRST: Read D:/dev/workspace-control/POLICY.md in full before taking action. Then read the assigned repository's applicable AGENTS.md and CLAUDE.md. Follow the current user-authorized workspace policy over obsolete task notes.

# Laptop handoff: saved DVIR photo view after sidecar integration

The laptop may not have the desktop D: drive. The full current desktop POLICY.md is copied below. Desktop lease commands apply only on this PC; use the laptop's own registered checkout and report its actual environment.

## Assignment

- Recipient/owner: laptop WB eQuipment Codex, reported session `01a139b5-d3f7-7401-bdf0-3443ec841c28`.
- Environment/existing checkout reported by laptop: `C:/dev/TicketTimeExpo/tmp/wbe-shop-20261012`.
- Assigned repository/remote: `tester3x/wellbuilt-equipment`, `https://github.com/tester3x/wellbuilt-equipment.git`.
- Verified GitHub branch/base: `codex/wbe-shop-20261012` at `ae4f933e09fbbb1b092a9ad8f7fd93d2be4f8de5` on 2026-10-29. Verify actual laptop branch, HEAD, dirty files, ownership and freshly fetched remote before editing; GitHub does not establish local laptop state.
- Desktop repository/home/remote: `D:/dev/Dashboard`, `https://github.com/tester3x/wellbuilt-dashboard.git`, branch `release/dashboard-current-20260927`, pushed source checkpoint `d06b2e87295a3e9e6e361fdef10a80af860f46ca`. Desktop is its sole writer.
- Objective: let a driver review a captured issue photo from a saved draft or signed DVIR report, including while offline, without changing the signed report or treating an old placeholder as an image. User authorized continued scoped DVIR source/tests/handoffs. The task authorizes app source, tests, commit and push in its registered home. No APK build/install, live deployment/CORS/rules change, customer data mutation, new checkout or second app writer is assigned.

## Desktop review and result

I read `docs/DESKTOP-DVIR-DEFECT-SIDECAR-RETURN-20261029.md` at Equipment GitHub HEAD `ae4f933e09fbbb1b092a9ad8f7fd93d2be4f8de5` and the pushed `inspectionEvidenceSync.ts` and `inspectionEvidenceRuntime.ts` at app code commit `180c6443f931f8db19d313d96e6be0d40432cae2`. The app's binding order, deterministic `e_<64hex>` ID, begin/PUT/finalize request fields and receipt matching agree with Dashboard source. The laptop's reported 785 tests and generated cross-source assertions are source evidence; no live endpoint/phone test has been claimed.

Dashboard source-only change at `d06b2e87295a3e9e6e361fdef10a80af860f46ca` adds a "View verified photo" action to the optional complete-report panel. The UI obtains a short-lived GET URL through `getEquipmentInspectionEvidenceReadUrl` only when a verified sidecar is attached, clears it when the report closes or changes, and does not store it in signed JSON. The server read path rechecks the verified evidence record, binding, report digest, driver/company, path and current Dashboard company permission before signing a URL. It does not trust an arbitrary URL from the report. The source gate for the full-report panel remains off by default.

Functions TypeScript build, Dashboard TypeScript and production Next build passed. Focused report/callable Jest: 2 suites, 14 tests passed, including denied Dashboard role and missing verified evidence on photo read. These tests use mocked Admin SDK/Storage; live Firebase roles, CORS, signed URLs and phone behavior are unverified. No Functions, Hosting, bucket CORS, rules, APK or customer data changed live. Server full-report and defect-evidence flags remain off by default; installed E107 is separate from this source.

## Laptop next work

1. Inspect the actual draft, completed-report and shift-history UI routes before editing. Add a saved-report photo view from `LocalInspectionEvidenceStore` only where a signed local reference has the matching owner, hash, size, type and readable private bytes. Show a clear missing/unavailable state when the original is gone. Keep the source `localDraftRef` and report digest unchanged. A cached verified receipt is not a substitute for local bytes in an offline view.
2. Keep old `local_placeholder_*` and imported remote strings as data-only compatibility; never show an unrelated photo or recreate a placeholder producer. Do not introduce public or persistent signed URLs to make the view work.
3. Test owner switch, offline restart, missing/corrupt file, draft versus sealed report, replaced shift cycles, cancel/close and unchanged signed digest. Run the app typechecks and focused tests. Preserve/push scoped work after GitHub reconciliation.

The PDF formatter currently lists evidence references; photo embedding is a separate decision. Do not change the signed report to make a PDF image. Report any exact app/server mismatch in the next handoff. Desktop still owns pending-object retention, historical shift association and isolated emulator/live/CORS release prerequisites. Do not infer an APK or backend release from source completion.

## Required return

Report actual laptop checkout/remote/branch/starting and final HEAD, changed files, checks and results, lease disposition, outstanding work, and exact committed/pushed/built/installed/deployed/verified state. State which saved-report views can show the owned photo and which still cannot. Preserve unrelated work and signed records.

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
