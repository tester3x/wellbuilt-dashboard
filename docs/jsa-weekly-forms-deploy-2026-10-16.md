# JSA weekly forms endpoint deployment

Deployed only `functions:dashboard:jsaWeeklyForms` to `wellbuilt-sync` on October 16, 2026, verified at approximately 10:48 PM America/Chicago (2026-10-17T03:48Z).

- Source: `a50478a6`, branch `release/dashboard-compact-identity-20261015`, matched origin before deployment. The existing untracked root app.json was not included in the Functions source or committed.
- Endpoint: `https://us-central1-wellbuilt-sync.cloudfunctions.net/jsaWeeklyForms`
- Function: `dashboard:jsaWeeklyForms`, us-central1, second generation. Firebase reports ACTIVE and deployment hash `605b5a532768467cdbc87eda346b49ecba5bffb0`.
- Deployment command: `firebase deploy --only functions:dashboard:jsaWeeklyForms --project wellbuilt-sync --non-interactive`.
- Predeployment: 10 focused ownership/history tests passed; Functions TypeScript compilation passed.
- Live no-session POST: HTTP 401 / UNAUTHENTICATED, message "Sign in to JSA."; no records returned.
- Live malformed callable envelope: HTTP 400 / INVALID_ARGUMENT; no records returned.
- Read-only Firestore query/index shape checks passed for governed requests, legacy JSAs, WB T job acknowledgements, and standalone records. No Liquid Gold governed sample was available, so these were empty sentinel-owner queries, not a live authenticated driver's historical export.
- Authenticated phone export, companion native provider behavior and actual PDF/ZIP handoff remain next-build device checks. No fake driver, shift, JSA or inspection was created for verification.

No Hosting, rules, indexes, other Functions, APK builds or installs were deployed by this operation. Firebase compiled the server TypeScript as required to deploy the endpoint.

## Next app builds

Use TicketTime `docs/weekly-work-forms-2026-10-16.md` for the coordinated source packet. App code checkpoints: TicketTime `dde0292` on `wip/etc-hos-timesheet`; WB E `ab76bde` on `codex/wbe-weekly-forms`; WB JSA `6f65d57` on `feat/jsa-register-join-code-20260917`. These code checkpoints are pushed. This feature requires all three updated apps; WB T and WB S have no new code dependency for this export feature.

The CLI warned that the existing Functions Node 20 runtime is due for decommissioning on October 30, 2026. This deployment succeeded; runtime migration remains a separate backend maintenance task before that deadline. No broad runtime or dependency upgrade was mixed into this scoped deployment.
