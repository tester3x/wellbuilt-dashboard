# Owner-confirmed fixed driver quantities

A parser fallback or trailer capacity remains provisional. A separate authenticated
per-driver `confirmed_fixed_load` policy may establish a constant amount when the
owner explicitly confirms that practice. Written amounts still win. Capped
defaults remain provisional and require review; invalid bottoms are not accepted.

Confirmed fixed loads retain their reported tracking bottom and carry explicit
confirmation provenance. They may train production without treating estimated
timestamps as confirmed. Existing `fixed_load` policy behavior remains unchanged.

The delivered-review endpoint also accepts routine provisional records whose
review badge is already clear. This permits an explicit office confirmation of
the original observation. It edits the same packet and waits for canonical
completion; no second load is created and timing uncertainty is preserved.

New handler tests verify fixed versus ordinary defaults and confirmation of a
routine provisional observation. Forty-four production/barrel/overnight/refresh
checks pass. The intake suite has six pre-existing decimal-notation fixture
failures, reproduced at the unchanged parent checkpoint; the two new handler
checks pass. The full changed intake suite reproduces exactly the same six parent
failures, with both additional handler tests passing. Lane and exact live-source
compilation pass.
No driver identities, customer messages, quantities or operational ledgers are
committed here.

## Rollout verified

Product checkpoint 21014230 is deployed to ingestWatchdogPullV2 and
reviewWatchdogDeliveredPullV2 through scoped live-source overlays. Intake changes
its barrel-decision and intake modules; delivered-review changes only the two
eligibility guards in its own older intake module. Every unrelated archive byte
is preserved. Downloaded deployed archives match the prepared overlays exactly;
runtime, trigger and IAM checks pass. The already-live processor preserves
reported Watchdog bottoms and recognizes confirmed quantity provenance, so no
processor or receipt-handler deployment was needed.

Authenticated per-sender confirmed defaults were applied without changing other
drivers' defaults. Existing canonical observations were confirmed through the
signed delivered-review/receipt workflow, retaining their packet IDs, quantities,
gauges and timestamps. Estimated timing remains estimated. Readback proves no
new loads or changed ownership. The affected wells are opted into inventory AFR
for subsequent sufficient observations; a short or timing-uncertain sample keeps
the previous rate rather than publishing an unsupported replacement. Eligible ON
is recomputed independently. Exact operational evidence remains private.
