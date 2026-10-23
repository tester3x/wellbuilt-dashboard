# Watchdog field health and recovery controls

The Watchdog page adds an HP health panel and admin recovery controls backed by
getWatchdogAgentHealth and requestWatchdogRecovery. Reads remain manual, with
the existing review inbox and all its fixes retained. The panel distinguishes
no installed helper, stale helper heartbeat, unavailable worker, paused watching,
overdue receiver checks, pending updates and completed/failed recovery requests.

Actions require company manageWells or verified platform administration on the
server. Requests include a reason and unique request ID; the HP executes only
the fixed server-authorized action and reports its outcome. A pending request
prevents another request until it finishes or expires. No raw queue, QR code or
message body is exposed by the health endpoint.

The helper still needs one installation on the currently unreachable HP. Until
then the page explicitly reports no heartbeat and disables recovery actions.
It does not claim that the HP is online merely because Firebase is reachable.

The Playwright health regression covers no idle polling, initial installation
state, authorized versus view-only controls, scoped requests, pending-command
locking and stale company responses. It is retained in mandatory Hosting
preflight alongside the existing manual-refresh and rejected-load recovery tests.
