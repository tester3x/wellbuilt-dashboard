FIRST: Read D:/dev/workspace-control/POLICY.md in full before taking action. Then read the assigned repository's applicable AGENTS.md and CLAUDE.md. Follow the current user-authorized workspace policy over obsolete task notes.

# Entertech company-backed setup: desktop discovery return

## Assignment and verified source

- Desktop owner/session: `01a14dbe-84e4-7ee3-bcae-9b69b3f15d14`, local PC, registered `D:/dev/Dashboard`.
- Repository/remote: `tester3x/wellbuilt-dashboard`, `https://github.com/tester3x/wellbuilt-dashboard.git`.
- Branch/base: `release/dashboard-current-20260927` at `d215b879cefcd3c995449414fadd9107965cacf0`; clean before this documentation. GitHub branch API independently reported the same HEAD on October 29. The registered home was claimed before this write.
- Incoming laptop packet: `tester3x/wellbuilt-equipment`, `codex/wbe-shop-20261012`, `docs/DESKTOP-ENTERTECH-COMPANY-ROLLOUT-20261029.md` at `b6f2f3dbd274f0fcf080cda753d14801e42011b1`. Laptop owner/session `01a139b5-d3f7-7401-bdf0-3443ec841c28`, existing `C:/dev/TicketTimeExpo/tmp/wbe-shop-20261012`.
- Objective: prepare a separate Entertech company with two provisional hot-oiler units and ordinary standalone JSA/DVIR, preserving Liquid Gold and all existing records.

## Read-only findings and exact prerequisite

1. `functions/src/security/companyOnboarding.ts` unconditionally throws `platform_onboarding_capability_undefined` at the start of both `adminCreateCompanyWithJoinCode` and `adminApproveCompanyOnboarding`, before its existing verified-platform-admin check. Dashboard `CompaniesTab` still contains a direct Firestore `setDoc` create path; that is not a safe substitute for approved onboarding. The current workspace policy defines no tenant-creation authority. Mike must choose whether the existing verified platform-admin authority (`wellbuiltAdmin === true` token claim plus enabled `platform_admins/{uid}` record) may create this isolated company. A choice was requested from him, along with an email for a separate Mike-controlled Entertech login. Do not create the tenant, turn off the gate, use the direct client write, impersonate a role, or move his Liquid Gold account until this is resolved.
2. Read-only `firebase functions:list --project wellbuilt-sync --json`, filtered locally to names/state only, showed `adminCreateCompanyWithJoinCode` and `adminApproveCompanyOnboarding` active in `us-central1`. None of the six inspection-profile callables, nor full-report/evidence callables, appeared in the live list. Active names do not prove their deployed code is safe or usable; source and deployment are separate.
3. `functions/src/equipment/services/equipmentService.ts` registers generic road units with `equipmentTypeId: 'truck'`; `functions/src/equipment/inspectionProfiles/service.ts` accepts truck assignments only for active registered `truck` units. `hot_oiler` is the inspection profile's equipment type. Entertech's `Hot Oil 1` and `Hot Oil 2` should be registered as trucks and assigned the published `hot-oiler-v1` profile. The desired-state JSON is a product mapping, not a Firestore seed.
4. The staged `hot-oiler-v1 / 20261029_candidate1` manifest has nine areas, 26 items and nine image references. Its remaining candidate images/checklist require operator review. No review or company approval was invented. The formal manifest excludes the marshmallow outtake.
5. Prior Dashboard checkpoints document that the canonical Storage rules are audited deny-by-default and checked-in `storage.rules` is stale/broad. Canonical bucket signed-PUT CORS lacks `x-goog-if-generation-match` and `x-goog-meta-sha256`. No rules, CORS, Functions, Hosting or records were changed in this pass.

## Continuation and acceptance

After Mike supplies the authority choice and separate account email, the desktop owner may implement and test the exact approved company-creation path, verify real live identity and collision behavior, deploy only reconciled scoped callables after full release checks, then establish the tenant/account and two truck records through canonical service paths. Publish only reviewed profile media/revision and save company settings after live storage/function checks. JSA's `Hot Oiler Work` assessment remains operator-review pending, and the JSA repository is owned by laptop. Report exact companyId, nonsecret unit IDs, profile revision and real role tests before claiming a working demonstration.

No company/account/unit/profile/JSA data was created, no invitation or billing was sent, and no APK or live resource was changed by this desktop discovery. This return records a real authority blocker plus live deployment evidence; it does not assign the laptop a new implementation task. Laptop may continue its independently authorized source and device work in its registered home. Do not infer that the app's source-only walkthrough can download a live profile yet.

## Required next return

Any later executable assignment must verify its own exact checkout/remote/branch/HEAD and owner, claim before local edits, preserve unrelated work, and report changed files, tests, pushed commit, deployed resources, company/account/profile receipts, installed app version and live round-trip evidence separately. This checkpoint's final commit/push status is recorded in the covering chat; there is no build, installation or deployment.

## Mandatory workspace policy for laptop recipient

The laptop cannot read `D:/dev/workspace-control/POLICY.md` from its own filesystem. The full current desktop policy is appended below; local `D:/dev` commands apply only on desktop, while laptop uses its own registered home and current policy.

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
