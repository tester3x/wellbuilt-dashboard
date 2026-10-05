# Flow-window replay checkpoint — 2026-10-05

Diagnostic only; no live processor changes or deployment. tools/flow-window-replay.mjs separates observation accounting from flow measurement windows. Every valid load retains its reported bottom and volume; tiny recovery carries measured level drops forward until a larger recovery window is available. Missing/unreadable observations and down states break the anchor; zero/negative time or negative recovery resets it. Duplicate IDs are rejected.

Four node:test regressions pass: cumulative production accounting across intervening loads; retained rate and reported bottoms; missing/down-state interval breaks; duplicate identity rejection and negative-recovery reset. Run node --test tools/flow-window-replay.test.mjs.

Private real-export replay compared thresholds 3, 6, 12 inches. All retained identical valid-load totals. All suppressed the observed zero-/two-inch back-to-back intervals. Six inches is a candidate, not a validated universal production threshold. Raw export/replay outputs remain outside Git. Compact ambiguous readings were treated as barriers, not silently skipped. Export time zone assumed America/Chicago; post times are not verified measurement times. Current calibration cannot be assumed historically; measured intervening level drops are used instead of inventing drop from barrels.

Not production-ready: ingest/processor/edit/delete recomputation must share an interval model, preserve measured bottoms, reconcile manual aggregates against individual captures and handle timestamp differences. Existing live duplicate check is not sufficient for manual aggregate equivalence. No historical import or backfill authorized by replay. Do not deploy this diagnostic as a finished fix or feed the export into live intake.
