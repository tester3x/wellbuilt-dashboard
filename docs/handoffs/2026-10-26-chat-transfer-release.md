# Chat and load transfers — 2026-10-26 release handoff

Product source deployed: `aef5b7a9be125172267824504f75d692e7da67cd`, branch `release/dashboard-chat-transfer-20261026`. Mandatory Hosting preflight and live verification passed for all 371 exported files. The release merged the fresh approved baseline before deployment and advanced the shared approved-base through the normal verification hook.

ChatSidebar and the full chat page use authenticated staff APIs with company-scoped capabilities. Server-provided scope, canonical participant identities, late-owner response rejection and durable same-ID text retries replace direct client Firestore writes. Initial offline bootstrap retries automatically; a later success clears recovered errors. Dispatch presents a capability-gated pending-transfer panel for assigning approval requests; assignment alone does not change job ownership.

Scoped Functions deployed: staffChat, staffLoadTransfers, hardened upsertDriverInvoice, hardened legacy sendChatMessage, transferRequestExpiry and runTransferRequestExpiryOnDemand. Downloaded deployed source bytes were verified. No database, Firestore or Storage rules were deployed.

The existing, positively verified owner authority record was extended with only the chat/dispatch capabilities required for this repair. Other accounts were unchanged. Initial failed creation left the two new staff callable transports without Cloud Run invocation policy; only those two transport policies were repaired. Firebase Auth, active company scope and capability checks remain inside each handler. Anonymous requests return UNAUTHENTICATED.

Verified: Functions compile, frontend typecheck/build, ten staff lifecycle/security/expiry emulator checks, owner-fenced durable staff queue tests in mandatory Hosting preflight, and actual owner-browser/S24 messages in both directions. The S24 offline message was absent from the server until reconnect, then delivered exactly once without an app restart.

Related WB T release is tracked in its `docs/chat-transfer-repair-2026-10-26.md`, branch `codex/wbt-enroute-20261014`. Its final APK264 source is `40bb938f93a4f309b63459731deb1a5cc4658b51`; device verification is still in progress at this documentation checkpoint.

Private authority backups, fixture identities, deployment logs and device screenshots remain outside Git. This documentation-only checkpoint does not require another Hosting deployment.

Final device release: WB T267, source `8bf1c192ba9e90b938bac2fde399e595a7695048`, EAS `c4e87d22-b4f2-46f5-8c2a-157b84d5fb28`, installed data-preserving on S24 and ZFold about04:41 Central. S24 proved original PW ticket/measurements/photos, separate SW number and server-confirmed explicit-start clock, pause/resume without clock reset, cold recovery, Copy and native-keyboard Send. The final chat PNG repair (`7887dc3`) passed29 driver emulator checks; deployed driverChat source bytes matched, anonymous calls returned401, and the original queued photo delivered automatically once after the fix. SW fixture close remained correctly blocked without verified JSA; no policy bypass was used. Software fixtures were retired without billing. See the WB T release note for exact APK hash, tests and physical-test limitations. No further Dashboard product or Hosting changes were needed.
