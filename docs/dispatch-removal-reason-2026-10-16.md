# Dispatch removal reason — 2026-10-16

User identified the missing reason field on Remove Dispatch. Added optional reason textarea (1000 characters), with existing explicit confirmation and blank allowed. Draft resets per selected job, remains on failure, and cannot change mid-submit. Client forwards a trimmed explicit reason including blank; old callers omitting reason remain compatible.

Governed dismissDispatch now allows only the additional reason field, validates string/length, and stores dismissReason in the same transaction as dismissedAt/dismissedBy for each dismissed member. Idempotent repeated dismissal never overwrites its original audit. Existing trusted authority, company scope, split-family checks and dismissal semantics unchanged. This does not cancel/delete invoice, ticket or WB M records.

Validation: Dashboard TypeScript passes; six client reason/wire tests pass; actual callable runtime test verifies entered/blank/omitted reason, actor/time, invalid input, idempotence; existing server dismissal suite 21/21 passes; Functions TypeScript build passes. No live removal was performed.

Integrated latest desktop Dashboard source through 6801e2c1 before editing, preserving demo changes. No Hosting/Functions/rules deployment. Desktop currently owns Dashboard release work. Required release order: scoped functions:dismissDispatch first, then certified Hosting release of combined source. Old deployed callable rejects the new reason field, so frontend-only release is insufficient. Do not deploy all Functions or any rules to deliver this change.
