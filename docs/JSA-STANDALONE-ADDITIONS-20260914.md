# Standalone JSA location additions

Additive `append` operation on `jsaStandalone`; no export or rules changes.
Owned open records accept a bounded location/activity assessment and explicit
acknowledgement. Server timestamps and attributes it, preserves the original
signed snapshot/job/hash, checks the reviewed revision, and deduplicates retries.
Closed, foreign, malformed, conflicting and stale submissions fail closed.
Existing create/get/list/close consumers retain their behavior.

Validation: functions TypeScript build passes; 39 Firestore emulator checks
pass, including two successive additions, retry after close, unchanged original
signature/assessment, ownership, forbidden fields and direct database denial.
All test documents are emulator fixtures; no live acknowledgement was submitted.

Lineage: freshly downloaded live jsastandalone-00001-laj source matches all 239
source files at pre-change HEAD 467f87f. Only jsaStandalone may be deployed.
No Dashboard/photo/WB-T/JSA governed endpoint, rules or Hosting deployment.

Client work: tester3x/wellbuilt-jsa fix/jsa-app-access-handoff-20260913.
Device review/acknowledgement and print verification remain for the driver.
