# Office alerts and tab return release — 2026-10-21

Hosting source: `b45cd7c2`, built and deployed from the clean `release/dashboard-office-return-20261021` worktree. Certified preflight passed its clean-tree, baseline ancestry, fresh build, header/navigation, Photo Review, 26 authenticated routes, autocomplete scroll and password-flow checks. Library regression: 460 pass, one existing skip (tsx runner).

Live `wellbuilt-sync.web.app` verification at 2026-10-21T22:21:17.286Z byte-matched all 111 generated HTML, JavaScript and CSS files to this release's output. Full artifact digests remain in private local release evidence, not Git.

The isolated `office-sync` Functions codebase deployed only `reportDriverSyncAlert` and `adminListSyncAlerts`. Both are ACTIVE; anonymous callable requests return 401 and the downloaded deployed office module byte-matches the tested compiled source. No rules were deployed. Alerts are in-product only and are checked on entry/focus/manual refresh, without a polling timer. Mobile reporting requires the new WB T build; deployment alone does not retrofit existing installed clients.

This release includes the Dispatch current-job ordering and duplicate destination-line cleanup. The working checkout's unrelated untracked app.json was preserved.
