# Watchdog receipt timestamp verification

Deployed only `getWatchdogPullReceiptV2` to `wellbuilt-sync` in `us-central1` from source `4077bd187a55521dd4606d61c6b8dae99c9a0e2e`. The active Node 22 revision `getwatchdogpullreceiptv2-00011-vus` was verified on November 9, 2026 at 08:48 UTC. The compiled intake and its receipt dependencies match the deployed archive. The ingest function's source generation remained the same.

The receipt compares the parsed measurement instant so equivalent UTC timestamps with and without fractional seconds match. The Functions build and four focused receipt tests passed. The regression failed against the original comparison. Two additional existing intake fixtures failed with both versions.

The HP refreshed one receipt successfully and reported zero pending deliveries and zero reviews. The original Kahuna 5 pull was still the sole processed record for that instant, with the same packet identity and payload hash. Its incoming path remained empty.
