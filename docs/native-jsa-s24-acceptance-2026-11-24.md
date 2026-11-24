# Native S24 JSA emulator acceptance

Requested offline native save/process restart, receipt retries and company switching completed. No deployment. Production Tickets460/JSA122 remained installed; Burger1 stayed paused, nine unrelated pending commands remained queued, and no signed-record action was taken. Fold was not operated.

Test variant: com.syconik801.jsaapp.audit v1. Source af6a9724779adccfcec4154a63ff2ed7cb64d6e1 from the registered JSA home, immutable android-native-audit-v1, APK SHA256 2abefee75b188870879e32be3043bc7b39fbcb74f9f7515e671e989c7a923c01, approved JSA signing certificate fc833ec7502cead7c5f7b0e5e394a2f7958ded629e92edb5ec7ff9522722d459. Local Gradle, exact clean committed source; no source checkout/copy or cloud build. Original generated Gradle restored exactly. Default production entry/package/version unchanged.

Fixture source 1fb3ac68 uses demo-wb-audit-s24 only. The native app called the real Functions emulator export through Firebase Functions SDK with real Auth-emulator custom-token sessions. Logs confirmed callable auth VALID. Server membership/rate-limit code used local Firestore/RTDB. The browser HTTP RPC adapter was not used (its call counter stayed zero). Synthetic fixture/verification HTTP server was used only for seed and proof retrieval. All fixture deploy hooks refuse deployment.

## Passed

- Hermes runtime, actual native AsyncStorage and persisted Firebase Auth.
- With radios off and test forwards removed, native save could not claim delivery; original/pending remained on native disk. Force-stop/relaunch while offline restored original, pending state and A's Auth session.
- Injected response loss after a successful server receipt commit retained pending state. Identical native replay confirmed the same receipt without re-signing or changing the original time.
- Real Auth A→B→A switching: foreign original refused before callable; authenticated foreign receipt denied; B history contained no A evidence; A pending original preserved. Switching during a response could not confirm A's work.
- Emulator proof: exactly one unchanged signed record, one original-time receipt. Native pending completion was persisted only after proof succeeded.
- Original radio state restored1/1. Production versions460/122 read back, Burger1 PAUSED and outbox sent0/kept9 after return. No production app replaced or data cleared.

Twelve client/native-isolation/retention tests and TypeScript also passed before the immutable build.

## Remaining before release

This is native component/transport acceptance, not full normal Tickets→JSA→Tickets UI or production SSO-session acceptance. Prepared/standalone flows, history/PDF and pending legacy recovery, server-side writers versus signed-snapshot immutability, expired/disabled sessions, actual candidate-rule combination and coordinated client migration/rollback still need acceptance. The old source-pin regression remains recorded separately. Strict rules stay last, after updated clients. No authority to deploy follows from this pass.

The lost-response case was deterministic client-side injection after SDK receipt success, not a timed physical disconnect during a socket response. Native progress assertions were preserved in logs/server report because the test surface's progress text did not render reliably. Raw logs, synthetic fixture tokens, native state and APK remain outside Git; production originals were never copied into the fixture. Full native test/build receipt is in JSA docs/native-audit-s24-pass-2026-11-24.json.
