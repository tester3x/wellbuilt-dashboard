# Multiple-load catch-up regression

The isolated backlog matrix exercises five observations for one well, delivered
in reverse, shuffled, and chronological order. Each order runs normally and with
one lost connection before intake, after intake acceptance, before processing,
or after processing. Both queue and simulated server journal reload from disk
between attempts, including while the oldest load is unconfirmed.

The production parser, durable queue, transport, observation digest and
`evaluateIncomingPull` stale-time guard run unchanged. The server adapter is
isolated; it does not contact Firebase. Each scenario asserts five ordered
acceptances, five unique ordered commits, no rejection, no premature completion,
and no extra commits or reviews after duplicate receiver replay. A negative
control proves the actual guard rejects a reversed timestamp.

A complementary Functions test invokes the actual signed intake and receipt
handlers against isolated Firebase stores. Five successive observations are
retried before processing, partially processed, confirmed, then replayed newest
first. Partial writes remain incomplete; all five complete receipts persist;
replay creates no incoming or rejected packets and no extra processed records.

Validation on the laptop: Functions TypeScript build passes; all 51 Watchdog
tests pass; the new Functions handler test passes (other intake cases explicitly
not selected). Existing unrelated intake fixture failures are outside this test.

HP verification at source `546afb61`: all 51 Watchdog tests pass, and the new
actual-handler Functions test also passes. Live status at 13:39:19 UTC remains
Connected, unpaused, transport Ready, eight watched channels, zero pending
deliveries, zero reviews and no remote review error. The live worker was not
restarted for these isolated tests.

No customer loads, live levels, or WhatsApp posts are created or modified.
These are regression/integration fixtures, not a live cloud end-to-end load test.
Only tests, the test command and this audit note change; no runtime deployment,
dashboard release, phone build or Watchdog restart is needed.
