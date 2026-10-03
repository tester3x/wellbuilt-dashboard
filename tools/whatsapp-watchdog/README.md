# WellBuilt WhatsApp Watchdog

Run from dashboard root: npm run build --prefix functions; then npm start --prefix tools/whatsapp-watchdog. Open http://127.0.0.1:8791. Connect WhatsApp, scan QR with your phone Linked devices, choose groups, save, and Start watching. Missing 165-barrel default is opt-in. Decimal feet stay decimal feet.

No Firebase credential and no outgoing WhatsApp messages. Automatic WB M delivery uses only the scoped HMAC intake. Download each group as TXT and use Admin > Import Pulls for server duplicate checks, calibration review and application. Local queue is not a WB M receipt.

State and linked-device browser session are private in %LOCALAPPDATA%/WellBuilt/WhatsAppWatchdog; never share the session folder. Override location using WBC_WATCHDOG_DATA and Chrome path using WBC_CHROME_PATH. Localhost-only listener with host/origin checks and per-process token. Restart requires Connect and Start; saved session normally avoids another QR scan. Pause stops capturing, Stop destroys the connection. No autostart installed.

Receiver checks up to the last 100 currently synced messages in each selected group every four seconds. It does not fetch complete history. Larger or unsynced gaps need an export. Connection state is checked before reading. A successful receiver check exposes its timestamp; authentication alone does not mean the receiver is running. Edits/deletions missed while disconnected may need manual reconciliation. Stable message IDs deduplicate repeats; edits replace old parsed rows and deletion withdraws them. ZIP/TXT sample replay uses one text file and bounded expansion. Repeated samples are idempotent. Test channels do not enable live capture.

Dependency whatsapp-web.js 1.34.7 uses WhatsApp Web, not an official Meta ingestion API; compatibility and authenticated session are required. See https://wwebjs.dev/guide/creating-your-bot/authentication . Automatic WB M transport requires the separately verified scoped ingestion/receipt endpoint; never bypass with driver or admin credentials.

Tests: npm test --prefix tools/whatsapp-watchdog. Tests persisted duplicate detection, edits, deletion and ambiguous multi-well messages against the real parser.

Automatic transport uses ingestWatchdogPullV2/getWatchdogPullReceiptV2, with server-selected channel/well scope, a deployment activation cutoff and a Windows DPAPI protected endpoint signing key. No Firebase or administrator credential is available to the daemon. Export sample rows, edits, missing bottoms and parser/setup warnings are held. Completion requires the owned packet identity, exact observation and canonical completion marker. Local Pause also pauses transport. Server and client cutoffs prevent historical replay. Current deployment activation and policy are private evidence under TicketTimeExpo/output/watchdog-auto-ingest-20261002.
