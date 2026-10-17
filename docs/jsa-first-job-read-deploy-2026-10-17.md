# First-job JSA read registration repair

The installed WB T first-job read request was rejected with `intent_not_permitted`. Read-only inspection of the live endpoint's source confirmed its old completion-style reader returned `allowRead: false` for `jsaJobPolicy: acknowledge`. This contradicts the required first-full-read, later-acknowledgement workflow.

The corrected policy reader was already committed in the accepted branch. No entitlement or job-completion checks were weakened. Added `functions/tools/test-jsaStylePolicy.cjs` executes the production reader against explicit/default policies and an unavailable policy read. First-job reads remain allowed; acknowledgement permissions retain explicit-policy precedence; disabled JSA remains disabled.

- Source: `fc5121e91576feeed0b2ec7452634a7d30e0ce59`, branch `release/dashboard-compact-identity-20261015`.
- Validation: Functions TypeScript build passed; 138 governed receipt assertions passed; production policy-reader fixtures passed.
- Command: `firebase deploy --only functions:dashboard:jsaRegisterReadRequest --project wellbuilt-sync --non-interactive`.
- Result: Successful update; ACTIVE. Update timestamp `2026-10-17T17:34:56.987875305Z`, revision `jsaregisterreadrequest-00003-ref`.
- Independent deployed-source download confirmed the compiled policy module byte-matches the local build. SHA256 `367C953B0BA9F18CDB1F5A14E5D0F760CB38E4A1C0240CF094333A332888B954`.
- Only this endpoint was updated. No Hosting/demo release, rules, app build/install, live job mutation, or fabricated JSA completion. Pre-existing untracked root app.json was left untouched.

Existing WB T 182 can retry registration against the repaired endpoint. Driver completion/return still needs live testing. WB T source checkpoint `9976250` separately makes rejected/unregistered local pending requests retryable without granting proof; that hardening awaits its next APK with the drawer and spacing changes.
