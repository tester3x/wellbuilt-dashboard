# Driver-planned job delivery follow-up — 2026-10-19

WB T branch: codex/wbt-enroute-20261014. Backend branch: release/dashboard-compact-identity-20261015.

Cloud request evidence showed a 76.99-second cold startup for driver dispatch creation. The app's eight-second outbox bound retained the stable create intent, but did not react to late success until a later external retry.

- dispatchCreate now observes the original delivery after timeout and immediately requests a coalesced outbox drain on successful late completion. Existing stable-ID create-if-absent replay and chain ordering remain intact. Failures never unlock a job or discard pending work.
- Both normal and compact drawer cards show Start Job for source=driver; dispatch offers retain Accept. Starting still follows the existing job review/JSA flow.
- Backend createDriverDispatchIfAbsent has minInstances=1 to reduce scale-from-zero delay. This retains one warm instance and has an ongoing hosting cost; scale-out and network delays can still occur.

Validation: five runtime tests (timely, late, failed, racing delivery, labels), WB T frontend typecheck and backend Functions build passed.

Committed source only. Not built, installed or deployed. Device behavior and production latency need verification after release. No customer records modified.
