# JSA location blocks deployment — 2026-09-16

Source commit: `4416b7ac357606ea39b6bbc3c45af178b1fca853`

Project: `wellbuilt-sync`

Deployed functions:

- `dashboard:jsaManageTemplate`
- `dashboard:jsaStandalone`

Both functions were verified ACTIVE in `us-central1` on Node.js 20 with deployment hash `f03f18273393ad11b8f6a21affb49048c877e94a`.

The deployment adds strict validation and persistence for template-controlled repeatable location blocks, stores the selected layout on each JSA, and accepts the explicit `conditionsDiffer` flag when a location is appended. If selected task templates disagree about the layout, no layout is guessed and the client uses the universal addendum fallback.

Validation completed before deployment:

- TypeScript build passed.
- 21 template-management cases passed.
- Task-catalog flow passed.
- 46 standalone server cases passed.
- The emulator-only end-to-end flow was not run because `FIRESTORE_EMULATOR_HOST` was not configured.

No Firestore rules, Storage rules, Hosting, routing functions, ticketing functions, or unrelated functions were deployed.
