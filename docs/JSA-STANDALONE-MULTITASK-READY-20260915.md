# Standalone multi-task JSA source checkpoint — 2026-09-15

No production deployment or installation. WB-T handoff and routing branches are untouched.

Backend: authenticated company-scoped jsaManageTemplate save/publish/deactivate/delete; server-owned metadata; immutable publication revisions; conflict validation; transaction-consistent catalog reads. parseJsaPdf now requires authorized company management and uses unique upload paths. Only these three callables are candidates for later targeted integration: jsaManageTemplate, jsaStandalone, parseJsaPdf. Existing unrelated exports remain intact.

Dashboard: template mutations use the callable, never direct writes. Lists no longer migrate data as a read side effect. Source rules restrict template reads and prohibit client writes. Do not deploy this whole historical rules file over current accepted rules; integrate the JSA-only changes into the reviewed release.

App: authenticated template fetch; a new standalone read verifies the catalog rather than falling back after a catalog/network failure; frozen multi-task drafts still resume. Acknowledged additions persist the exact request before sending, retry after restart/lost response, and stay scoped to canonical company/driver. A confirmed stale-review refusal requires new user review. Paper report shortcut now shares the read/thermal renderer and includes archived wording, versions, additions and signature.

Verification:
- Backend TypeScript passed.
- Publication permissions/lifecycle: 19 fixture cases passed (including a malformed enabled flag).
- Standalone server: 46 fixture cases; 47 with Firestore emulator passed.
- Full standalone publication/sign/add-task/retirement-retry/close flow: 14 checks passed against backend source rules, and 14 against Dashboard source rules. Demo emulator only.
- Existing governed receipt suite: 114 passed, 0 failed after explicit deny blocks were added. Previously missing explicit block is covered by a catch-all deny in this backend source. No statement about deployed rules is implied.
- App TypeScript passed; pending-addition/print adapter: 9 cases passed; existing receiver queue: 90 passed.
- Task selection/draft, client ownership and document paper/3-inch/4-inch suites passed.
- Dashboard callable transport: 5 assertions passed. Next webpack build exported all 26 pages successfully.

Release follow-through: review these isolated changes against the currently accepted Dashboard lineage; retain other agents' changes to Functions exports/rules. Deploy only reviewed JSA callable targets and JSA rule changes, then enable a company catalog and test the preview on device. The multi-task required-job WB-T receipt path remains intentionally unavailable until its separate integration is finished. No live acknowledgements or signatures were manufactured. No test-data recovery work.
