# Slow-well pipeline WIP — 2026-10-05

Source checkpoint only; not deployed or activated.

Implemented combined-manual-load containment guard in signed watchdog intake. Same well, compatible owner, nearby time, two-to-four load multiple and level containment cause review before any packet is queued. This is a conservative warning, not automatic equivalence; volume is never silently removed. Ordinary time confirmation cannot bypass this separate reconciliation hold. Existing receipt/identity paths are unchanged.

Implemented functions/src/flowWindows.ts as shared deterministic history recalculation model. Held intervals contribute zero new rate samples. It uses observed intervening drops, retains every original observation, breaks on down/no-level/invalid records and rejects unreasonable recovery thresholds. Editing a held bottom changes the downstream accumulated recovery when replayed. Threshold is configurable by the caller; no live well config was changed.

18 focused Functions tests pass; TypeScript build passes. Four offline replay tests also pass. Private export and operational history excluded from source control.

Remaining required work before live activation: wire canonical processPacket, AFR/window/overnight summaries, edit outbox and delete cascade to the same recomputation path; decide how validated reported bottoms replace calculated ones; serialize aggregate reconciliation and late delivery; verify non-Watchdog regression paths. The intake guard is integrated but no Function deployment has occurred. No Firebase mutations or historical imports.

Follow-up: signed intake now records server-calculated six-inch flow-window diagnostics in watchdog provenance and delivery records (shadow mode). Canonical measurement and flow fields are not overwritten. Repeated packet IDs in history are counted once. 26 flow-window/overlap/intake/sender-ownership tests pass; TypeScript build passes. Scoped intake deployment is staged separately from future canonical processor integration.
