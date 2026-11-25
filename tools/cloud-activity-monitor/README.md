# WB Cloud Watch - local, read-only

An always-on-top Chrome/Edge Document Picture-in-Picture panel backed by Google
Cloud Monitoring. Start `start-monitor.ps1`, then click **Float monitor** in the
opened browser page. If another browser is the default, open the printed local
address in Chrome or Edge. Leave that parent tab open. Closing the floating
window returns the panel to the tab. Closing the tab stops local polling; after
ten minutes without a viewer, the server stops its own collector. No startup
task is installed. Restart the launcher after reboot or idle shutdown.

Node polls native platform metrics once per minute; the browser polls only its
private local aggregate snapshot every five seconds. Neither invokes a deployed
function, writes Firestore, sends messages or stops production. The server binds
only to 127.0.0.1, rejects writes and cross-origin reads, and exposes no credentials.

Needs Node and that Windows user's existing Firebase CLI sign-in. No service
account/key is exported, copied or embedded. Another PC must sign in independently.
The Firebase Tools library defaults to its standard per-user npm installation;
`WB_FIREBASE_TOOLS_LIB` supports a separately installed existing location.

Snapshot/logs default to `%LOCALAPPDATA%/WellBuilt/CloudActivityMonitor`; the
launcher accepts `-DataDir ABSOLUTE_PATH`. Keep these and auth files outside Git.
The collector uses only Monitoring GET requests, four metric types per minute
(pagination only when needed): Cloud Run requests, legacy function executions,
Firestore reads and writes. Metrics can be delayed; sample time is distinct from
refresh time. Missing, failed, truncated or stale data never becomes green.

Initial local thresholds, per minute: each function warning 120 / critical 600;
Firestore reads 3,000 / 10,000; writes 1,000 / 5,000. Ten server errors per function
also warn. These are diagnostic settings, not service quotas or spend caps.
Optional private `thresholds.json` overrides matching keys from `metrics.cjs`.
This monitor cannot change billing, budgets or quotas.

Sound is opt-in. Persistent provider-side alert policies and notification channels
remain a separate step. A local monitor cannot alert while its computer is asleep,
offline or closed. This is an activity monitor, not an invoice/cost meter.

Validation: `node --test tools/cloud-activity-monitor/*.test.cjs`. A synthetic
display can be served with `node web-monitor.cjs --demo --data ABSOLUTE_PATH
--port 8794`; supply a synthetic status.json there. It starts no collector and is
clearly marked DEMO. Never use demo data as production evidence.

The earlier `CloudWatch.cs` / `build-monitor.ps1` native prototype compiles, but
Windows Application Control blocked its executable on the laptop. It is not the
supported launcher. No policy, whitelist or trust setting was changed. The
browser panel uses the installed browser's normal Picture-in-Picture feature.

Rolling history: the collector now journals its existing completed minute samples
locally under `history/metrics-YYYY-MM-DD.jsonl` for30 days and writes
`history-summary.json` for the viewer. Click History for hourly totals, a minute
trend, measured spike times and per-metric coverage. No extra metric queries or
Firestore calls are added to ongoing collection. Overlap/restart/corrections
replace the same minute rather than inflating totals. Missing data is never zero.
Relative read/write bursts are marked in history; live alert thresholds remain
separate. Fake test alerts are renderer-only and never enter measured history.
Keep the local monitor running; closed/sleeping periods are gaps, not invented
zero-traffic hours. Every PC keeps its own local history and own CLI sign-in.
