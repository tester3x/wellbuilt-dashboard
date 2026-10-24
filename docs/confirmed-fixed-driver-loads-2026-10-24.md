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
checks pass. Lane and exact live-source compilation pass. Rollout pending.
No driver identities, customer messages, quantities or operational ledgers are
committed here.
