# Fixed driver defaults and historical review completion

Branch codex/watchdog-combined-time-20261019, base cea458b7. This lane contains the deployed Watchdog combined-time/parser/review features; no Dashboard Hosting, demo, rules, identity or app APK change.

Operator-authorized per-driver defaults now have an explicit opt-in mode: channel.driverDefaultModes[key]=fixed_load with a matching numeric driverDefaultBbls[key]. Written barrels and review corrections take precedence. Capacity alone and ordinary defaults keep existing estimation behavior. Fixed defaults preserve reported tracking bottom, remain provisional evidence (do not train AFR), and require review if a stricter configured ceiling caps them. No other driver is enabled implicitly.

Historical correction receipts can finalize against a completed non-latest edit outbox without the latest outgoing-view marker. Proof binds company, well, packet, observation digest, active edit event, sequence, canonical completion and exact corrected top/bottom/barrels/time. It does not republish a historical level as the latest reading.

Validation: eleven focused barrel/historical receipt cases pass; one new intake integration case passes. Broader parser/Watchdog run had82 pass and six failing intake assertions; the same six failures reproduced on the unchanged HEAD intake source (feet/inch and older receipt fixture assumptions). They are not represented as passing or repaired by this change. TypeScript build passes. Operational before/after records and review authorization remain private outside Git.

Pending at checkpoint: scoped deployment of ingestWatchdogPullV2 and getWatchdogPullReceiptV2 only, enable the specifically authorized fixed default in live config, verify pending historical receipts clear, and verify all original corrected packet IDs remain in WB M with no duplicate pulls.
