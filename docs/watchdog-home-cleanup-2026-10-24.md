# Home Watchdog cleanup — 2026-10-24

Source checkpoint: dd8b182a on codex/watchdog-combined-time-20261019.

- Matilda's whole-line numberless report was held despite a single channel-scoped Matilda 2. Generic whole-line family lookup now resolves only a unique configured numbered candidate. Explicit different numbers, unrelated prose, foreign channel names and multiple candidates remain held.
- A reviewed null bottom now clears the contradictory-bottom parser issue. Original reported measurements remain in provenance; no replacement measurement is invented. Calibrated top-minus-confirmed-barrels remains the WB M processing input.
- Owner confirmed both outstanding Gabriel loads at 140 BBL; protected local review calls succeeded without duplicating prior deliveries.
- Owner confirmed Danny's 165 BBL policy and requested ignoring the mistyped bottom. G3 review and Matilda delivery still awaiting final live readback at this checkpoint.

TypeScript build passed. Focused parser/review tests: 47 passed. HP catch-up/recovery/order tests: 35 passed. Broader intake suite has six existing failures; unmodified HEAD was explicitly rerun and reproduced the same six before the source was restored, so these were not introduced by this fix. Keep that limitation visible.

Only ingestWatchdogPullV2 and decideWatchdogReview were deployed. No Hosting or rules deployed. HP fast-forwarded to the source checkpoint, verified the compiled parser copy, retained queue/parser backups outside Git and restarted through its existing supervisor. Final receiver health and canonical receipt checks pending.
