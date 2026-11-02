# Pumper gauge lists — 2026-10-16

HP authoritative source checkpoint e86a1266 on codex/watchdog-stockyard-20261016.

Pumper multi-well gauge rounds must be ignored/rejected, not imported as level observations or converted into loads. Their WhatsApp timestamp does not turn them into driver observations.

Root cause: local timing/format review checks ran before the server's top-only sender policy. Transport now defers top-only eligibility to the server, migrates unreviewed legacy holds through that policy once, and persists the check. Explicit exclusions, user review decisions and delivered identities are preserved. Intake ignores batches of at least three parsed top-only wells. Actual pull reports, mixed pull batches and approved single-well top-only observations retain their paths.

Tests: HP worker suite 25/25; focused server sender-policy and pumper-list regressions 3/3; local Functions build passes. Prior broad intake fixture failures are unchanged.

Live action: four remaining pumper-list holds rejected through the review API. Earlier exclusions preserved. Review count 22 to 18 at cleanup. No WB M observation or load was created by cleanup. Sender bindings and driver activation dates were not changed. Luiz remains future date gated and requires a verified sender binding; do not describe him as currently activated.

Release: only ingestWatchdogPullV2, using its previously downloaded live baseline plus the list-ignore guard. HP receiver must restart to load transport. Verify deployment success and Connected/unpaused capture before reporting completion. No Hosting, rules or APK deployment.
