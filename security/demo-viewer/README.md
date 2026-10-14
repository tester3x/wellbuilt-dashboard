# Demo viewer rules release

These files began as the active `wellbuilt-sync` rules on 2026-10-12, before the `demo_viewer` additions. The Firestore release was `projects/wellbuilt-sync/rulesets/c0995ce7-25c5-4f50-934f-ab08d396605a` (SHA-256 `054649211a3d18e492397a54b0fee274d7baef720ca275a1edf5e60868336316`). The active RTDB rules matched `D:/dev/_production-preflight-20260922/evidence/database.rules.json` semantically before editing.

Only the fixed shared Auth UID `wellbuilt-demo-shared-viewer`, with server-minted `staffRole: demo_viewer`, `staffCompanyId: wellbuilt-demo`, and `isDemo: true` claims, can use the added reads. Firestore records must have `companyId: wellbuilt-demo`; RTDB collection queries must filter `companyId == wellbuilt-demo`, and individual well and driver records must belong to that company. Real demo-company jobs need no simulator marker. All new permissions are read-only.

Deploy only after comparing both rule files against the currently active rules and confirming that the only differences are these demo reads. The repository-root `firestore.rules` and `database.rules.json` are stale and must not be deployed. This scoped config is intended for `firebase deploy --config firebase.demo-viewer.json --only firestore:rules,database --project wellbuilt-sync` after emulator and live-scope verification.

Run the local denial tests with `npx firebase-tools emulators:exec --config firebase.demo-viewer.json --only firestore,database --project demo-viewer-rules-test "node security/demo-viewer/test-rules.mjs"`. The emulator must be able to open a Java loopback socket; the Windows host used for this change could not start either emulator, so the Firestore candidate was also compiled and checked with Firebase's Rules API before release.
