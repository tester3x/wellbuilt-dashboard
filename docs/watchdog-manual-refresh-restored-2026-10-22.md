# Manual Watchdog refresh restored — 2026-10-22

The live Watchdog HTML exactly matched the October 21 office/tab-return Hosting export. That release had the earlier responsive-refresh component, including its 15-second list interval, but lacked the manual-only change previously deployed from the separate Watchdog hotfix branch. This was a source integration regression, not a new need for polling.

Restored the previously approved manual-only component and its browser test onto the exact live UI baseline (b45cd7c2). Also integrated the fix into the continuing release/dashboard-compact-identity-20261015 source branch. Added the no-idle-polling browser test to the mandatory Hosting preflight so the normal release path checks it before deploying.

Built/deployed frontend source: f5a8b803 on release/dashboard-watchdog-manual-20261022. Relative to the proven live UI baseline, only the Watchdog component, its existing browser test and the Hosting preflight changed. Existing demo, navigation, completed-date, Dispatch and office-alert UI changes were retained. The separately deployed NDIC/catalog Functions changes were untouched.

Verification:

- Browser test: two simulated minutes with no idle list request; manual click, immediate busy feedback, duplicate-click suppression, failure/retry, checked time and stale-company response isolation passed.
- Library suite: 460 passed, one existing skip.
- Certified clean release preflight passed: approved baseline ancestry, fresh build/TypeScript, manual Watchdog refresh, header/navigation, Photo Review, all 26 authenticated routes, builder scroll and password flow.
- Hosting-only deployment completed. No Functions, database, Firestore or Storage rules were deployed.
- At 2026-10-22T21:24:51.115Z, all 111 generated HTML/JavaScript/CSS files fetched from production exactly matched the fresh release output. Private byte-proof remains outside Git.

The inbox loads on entry/company change and after a user saves a review decision. Refresh checks for new reviews; no scheduled interval remains. Already-open browser tabs need one reload to load the new JavaScript.
