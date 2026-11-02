# Home Watchdog cleanup — 2026-10-24

Source checkpoint: dd8b182a on codex/watchdog-combined-time-20261019.

- Matilda's whole-line numberless report was held despite a single channel-scoped Matilda 2. Generic whole-line family lookup now resolves only a unique configured numbered candidate. Explicit different numbers, unrelated prose, foreign channel names and multiple candidates remain held.
- A reviewed null bottom now clears the contradictory-bottom parser issue. Original reported measurements remain in provenance; no replacement measurement is invented. Calibrated top-minus-confirmed-barrels remains the WB M processing input.
- Owner confirmed both outstanding Gabriel loads at 140 BBL; protected local review calls succeeded without duplicating prior deliveries.
- Owner confirmed Danny's 165 BBL policy and requested ignoring the mistyped bottom. G3 review and Matilda delivery still awaiting final live readback at this checkpoint.

TypeScript build passed. Focused parser/review tests: 47 passed. HP catch-up/recovery/order tests: 35 passed. Broader intake suite has six existing failures; unmodified HEAD was explicitly rerun and reproduced the same six before the source was restored, so these were not introduced by this fix. Keep that limitation visible.

Only ingestWatchdogPullV2 and decideWatchdogReview were deployed. No Hosting or rules deployed. HP fast-forwarded to the source checkpoint, verified the compiled parser copy, retained queue/parser backups outside Git and restarted through its existing supervisor. Final receiver health and canonical receipt checks pending.

## Final verified result

Recovered both older held observations through the authenticated, audited
historical-resolution implementation. Exact one canonical historical record per
load was verified, with each newer live well status byte-for-byte unchanged.
All four local delivery receipts are complete and needsReview=false.

The recovery check exposed two general defects: discarded null bottoms must keep
their original observation identity even when the receipt displays a calculated
bottom, and recovery must use configured bank calibration rather than assume
20 BBL/ft per tank. Source 6aebdfc3 fixes both. Seven historical-recovery tests pass,
including idempotence, interruption/retry, ownership rejection, null-bottom
binding and configured bank geometry. The scoped recovery callable update is
being verified separately.

HP and cloud: Connected, Ready, unpaused, nine watched chats, zero pending, zero
reviews, no receiver error and no remote-review error. The authenticated live
Dashboard independently showed those same values and “No pulls waiting for review.”
User authorized closing ChatGPT and WhatsApp desktop on HP; only those apps were
closed, leaving the receiver/browser/supervisor running. Immediate free memory
increased from roughly 55 MB to 233 MB. No startup settings were changed.

Recovery callable source 6aebdfc3 deployed successfully and independently verified
ACTIVE after the update. All cleanup work and durable fixes are complete.
