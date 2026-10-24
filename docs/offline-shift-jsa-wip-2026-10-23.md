# Prepared offline shift JSA — implementation checkpoint

Not yet accepted on a physical device. Application wiring/native builds are in progress separately.

The new `jsaOfflineShift` callable prepares a durable owner/work-period grant with all authorized operators, immutable JSA assessment content, qualifying full-read reference, company job settings and per-operator photo requirements. It does not replace any existing composed Start endpoint. Explicit Off remains distinct from unavailable configuration; full read and acknowledgment policies remain distinct.

Late actions retain the original shift, content hash and occurrence time. Replay authenticates current canonical membership, verifies the owned invoice/operator and original persistent period, validates signed read content, and writes an immutable exact-event receipt in the same transaction as JSA evidence. Concurrent retries deduplicate; a changed payload at an existing ID refuses. Completed reads use the established governed request/artifact formats so existing historical readers can consume them. A finalized shift accepts actions that occurred before its end, not later actions. Transient store errors stay retryable.

Validation at checkpoint: Functions TypeScript build, 23 pure validation cases, and the compiled callable against an isolated demo Firestore emulator. The emulator exercises concurrent response retries, signature artifact persistence, owner isolation, unknown full reads, incomplete switches, immutable IDs, wrong policy actions, and replay after shift end. No production work records are created by those tests.

Remaining acceptance: server preparation against the dedicated test identity; application/native builds; physical online preparation then offline new-job Start/full read/acknowledgment/Close, app restart, reconnection and exact-once server confirmation. Do not label this source checkpoint a verified offline rollout.


## Office escalation companion

Source `12c79a9a` adds the offline JSA evidence operation to the existing office
alert contract. Canonical shared driver sessions with an unset application
claim are accepted; explicit wrong-app claims still refuse. JSA alerts check
the referenced invoice's company and driver. Seven focused tests and the
Functions TypeScript build pass. Only `reportDriverSyncAlert` was deployed,
verified ACTIVE at `reportdriversyncalert-00002-xuf`; downloaded deployed handler
bytes match the compiled checkpoint. Unsigned invocation returns 401. Routine
retry thresholds and permanent resolution tombstones are unchanged.
