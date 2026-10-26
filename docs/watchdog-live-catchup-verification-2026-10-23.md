# Live catch-up delivery verification

Verified the production Watchdog durable queue and signed transport through the
live Firebase intake, canonical processor, completion receipts, WB M outgoing
state and the installed WB M history screen on the connected S24.

Three synthetic observations for the existing Test Well were queued newest first
while delivery was paused, then reopened from disk and delivered. Measurement
times were 40 minutes apart, with 40, 60 and 80 BBL respectively. No real work,
shift, inspection, invoice or production well was changed.

The run deliberately discarded the first successful live intake response and
the first successful completion receipt. These faults were thrown only after
the real server returned its answer; responses were not mocked. The durable
worker was reopened between delivery cycles.

Results:

- Exactly three new canonical processed rows, each with server completion proof.
- Server completion order follows measurement order, oldest first.
- No corresponding incoming or rejected packets remain; no stale rejection.
- Latest well status and outgoing response reference the third load.
- Replaying the original captured observations and submitting all three original
  observations again to the live intake creates zero extra processed rows.
- WB M on the S24 displays all three dates once, with expanded details confirming
  40, 60 and 80 BBL and the matching top/bottom levels.
- Temporary backend channel access was limited to Test Well and removed after
  verification. Synthetic history remains available for inspection.

Scope limitation: the laptop is on a different network from the HP. This run used
the production Watchdog queue/transport on the laptop; it did **not** exercise
WhatsApp message sending or the HP receiver's history fetch. That remaining
receiver-to-queue check requires the HP to be reachable. Existing isolated tests
cover its paging/checkpoint recovery separately, but are not a substitute for
that live receiver check.

Verification finished at 14:08 UTC on October 23, 2026. Private evidence and
operational scripts remain outside Git. No product code or deployment changed.
