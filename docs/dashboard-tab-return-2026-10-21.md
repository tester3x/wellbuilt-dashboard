# Dashboard tab return — 2026-10-21

Switching primary tabs returns to the previous URL, filters, supported view selections, expanded Dispatch drivers and scroll position. State is session-only and scoped to the signed-in user and operating company. It stores presentation state, not cached work records or drafts. Explicit links with a different query retain precedence. Modified clicks still open links normally.

The central scroll controller handles the document and named Dispatch panes, retries after asynchronous content layout, and yields immediately to user interaction. Tab changes do not retain mounted pages or add background requests. Existing Dispatch URL state now includes its workspace and jobs subtab.

Validation: return-state harness covers company/user separation, stale callbacks, query precedence, delayed data layout, individual panes, manual scrolling and cleanup. Header/navigation guardrails and TypeScript pass. The library suite passes 460 tests with one existing skip using `npx tsx --test src/lib/__tests__/*.test.ts`; plain Node cannot resolve three existing extensionless TypeScript imports. The deployed-callable inventory additionally records the two verified office-sync endpoints.

Release must use the clean canonical release worktree and Hosting preflight. The working checkout's unrelated untracked app.json is preserved.
