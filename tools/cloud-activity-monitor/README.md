# WB Cloud Watch — local, read-only

Small pinnable Windows window backed by Google Cloud Monitoring, not a new
Firebase function. Node polls native platform metrics once per minute; the UI
only reads the private local snapshot. It never invokes a deployed function,
writes Firestore, sends messages or stops production. Closing it stops only its
own collector process. No auto-start task is installed.

Build exact clean pushed source with `build-monitor.ps1 -OutputDirectory ABSOLUTE_NEW_PATH`.
This uses Windows' existing .NET Framework compiler and creates the native
`WBCloudWatch.exe` plus its runtime collector files outside Git. Launch with
`start-monitor.ps1 -AppDirectory ABSOLUTE_PACKAGE_PATH`. The launcher starts
the app without a terminal window. A private `current.json` can later select
the installed package; no startup task is added.
Needs Node and that Windows user's existing Firebase CLI sign-in. No service
account/key is exported, copied or embedded. Another PC must sign in independently.
The Firebase Tools library defaults to its standard per-user npm installation;
`WB_FIREBASE_TOOLS_LIB` supports a separately installed existing location.

Snapshot/logs stay under `%LOCALAPPDATA%/WellBuilt/CloudActivityMonitor`.
Keep them and any auth files outside Git. The collector uses only Monitoring
GET requests, four metric types per minute (pagination only when needed):
Cloud Run requests, legacy function executions, Firestore reads and writes.
Metrics can be delayed; the displayed sample time is distinct from refresh time.
Missing, failed, truncated or stale data never becomes a green status.

Initial local thresholds, per minute: each function warning 120 / critical 600;
Firestore reads 3,000 / 10,000; writes 1,000 / 5,000. Ten server errors per function
also warn. Thresholds are initial diagnostic settings, not service quotas or
spend caps. Optional private `thresholds.json` overrides matching keys from
`metrics.cjs`. This monitor cannot change billing, budgets or quotas.

Persistent provider-side alert policies and notification channels are a separate
step. Local sound is not an alert when this computer is asleep or closed.
The launcher supports `-Demo -DataDir ABSOLUTE_PATH` to inspect clearly marked synthetic
data without starting a collector or playing sounds. Do not pass demo data as
production evidence.
