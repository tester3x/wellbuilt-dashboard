# Driver DVIR ledger: equipment cycles within one shift

Branch fix/dvir-completion-firebase-20260912; base 6801ad00. User requested Shop breakdown post-trip and replacement pre-trip without ending the driver shift. Existing unrelated ssoCallables working-copy modification is preserved and excluded.

recordDriverDvirCompletion now retains completed earlier equipment pairs when a later replacement pre-trip arrives. A replacement cannot start before the earlier post-trip, reuse an archived identity or roll timestamps backward. The active pair becomes the replacement, with its post-trip due; old immutable proofs remain in equipmentCycles. Replays of old proofs acknowledge the exact old completion without changing the active pair. Same-identity changed bodies remain conflicts. Existing owner, equipment-session and server-owned shift checks remain unchanged. No claim/close/return endpoint changes.

The response adds acknowledgedCompletion so Equipment can confirm historical replay separately from the active pair. Legacy response fields retain the active state. Cycle count is bounded at 32 archived pairs per driver shift; overflow is rejected rather than deleting evidence.

Validation: 11 pure-ledger tests pass, including prior ownership/recovery/immutability cases and new cycle progression/replay/conflict cases. Functions TypeScript build passes. Companion Equipment source publishes archived cycles before current pairs, ignores local equipment groups for driver-shift authority and retains all signed forms in weekly export. Suite checks cached receipts against current server equipment proofs and archives verified superseded receipts.

Deployment pending. Release only recordDriverDvirCompletion from an exact committed snapshot; do not deploy unrelated Functions, Hosting or rules. No live DVIR, driver shift or customer record has been manually edited.

## Targeted release

Deployed only dashboard:recordDriverDvirCompletion in us-central1 to wellbuilt-sync from an exact git archive of 7b73f5f1. The clean exported snapshot compiled successfully; unrelated SSO working-copy edits were excluded. Firebase reported Successful update operation and Deploy complete. The first unqualified function filter matched nothing and aborted without changes; the codebase-qualified retry succeeded. No other Functions, Hosting, rules or customer/shift records were deployed/edited. Companion local builds: Equipment98 (db502b0), Suite100 (185465f), existing Tickets274 (72c7e884). S24 entry checks passed; genuine signed physical acceptance and ZFold rollout remain pending.

Observed deployment prerequisite: Firebase warns Node.js 20 is decommissioned 2026-10-30. Runtime was not changed in this targeted release; schedule a tested server-runtime upgrade as a separate substantive batch before that deadline.
