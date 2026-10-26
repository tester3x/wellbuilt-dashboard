# Chat and load transfers — 2026-10-26 release handoff

Product source deployed: `aef5b7a9be125172267824504f75d692e7da67cd`, branch `release/dashboard-chat-transfer-20261026`. Mandatory Hosting preflight and live verification passed for all 371 exported files. The release merged the fresh approved baseline before deployment and advanced the shared approved-base through the normal verification hook.

ChatSidebar and the full chat page use authenticated staff APIs with company-scoped capabilities. Server-provided scope, canonical participant identities, late-owner response rejection and durable same-ID text retries replace direct client Firestore writes. Initial offline bootstrap retries automatically; a later success clears recovered errors. Dispatch presents a capability-gated pending-transfer panel for assigning approval requests; assignment alone does not change job ownership.

Scoped Functions deployed: staffChat, staffLoadTransfers, hardened upsertDriverInvoice, hardened legacy sendChatMessage, transferRequestExpiry and runTransferRequestExpiryOnDemand. Downloaded deployed source bytes were verified. No database, Firestore or Storage rules were deployed.

The existing, positively verified owner authority record was extended with only the chat/dispatch capabilities required for this repair. Other accounts were unchanged. Initial failed creation left the two new staff callable transports without Cloud Run invocation policy; only those two transport policies were repaired. Firebase Auth, active company scope and capability checks remain inside each handler. Anonymous requests return UNAUTHENTICATED.

Verified: Functions compile, frontend typecheck/build, ten staff lifecycle/security/expiry emulator checks, owner-fenced durable staff queue tests in mandatory Hosting preflight, and actual owner-browser/S24 messages in both directions. The S24 offline message was absent from the server until reconnect, then delivered exactly once without an app restart.

Related WB T release is tracked in its `docs/chat-transfer-repair-2026-10-26.md`, branch `codex/wbt-enroute-20261014`. Its final APK264 source is `40bb938f93a4f309b63459731deb1a5cc4658b51`; device verification is still in progress at this documentation checkpoint.

Private authority backups, fixture identities, deployment logs and device screenshots remain outside Git. This documentation-only checkpoint does not require another Hosting deployment.
