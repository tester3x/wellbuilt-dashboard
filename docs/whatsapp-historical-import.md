# WhatsApp historical pull import

Open Admin > Import Pulls. Staff must have the trusted company capability used
for well management and access to the global well pool. Ordinary driver sessions
cannot preview or apply imports. Deployed Firestore default-deny rules protect
server-owned staging; no rules changes are part of this feature.

Upload one ZIP/TXT channel at a time, select the well for unnamed shorthand, set
missing-barrel default only when appropriate, choose chat time zone/date order,
and optionally limit dates. Parse again after changing settings. Written barrels
win; periods mean decimal feet. The preview maps exact catalogue/NDIC aliases,
checks calibration, structural validity, existing pulls and suspicious close times.
Original messages stay collapsed. Rows are editable and paginated in groups of 25.

Tank-change notices require review. Split historical date ranges at a bank change
and enter the total barrels per foot across active tanks. An override differing
from current calibration saves history but preserves the current average. A load
whose reported bottom differs materially from calibrated removal is flagged.
Never silently adopt a setup described in a chat post as current configuration.

Preview is bound to caller UID/company, expires after 20 minutes, and refuses
application after live history/config/status changes. Only selected READY rows
apply. Deterministic content identities and server transactions prevent repeated
export imports from creating extra historical records. Apply replay returns the
saved result. Interrupted batches require a fresh preview; already saved rows are
skipped. Download the report after import.

Historical packets go directly to packets/processed, not incoming. They carry
source/batch/calibration provenance, do not impersonate driver IDs, and create no
invoice, dispatch, payroll or canonical job. Last live pull, down state and original
records remain intact. Valid intervals seed the existing anomaly/step/EMA average
using the confirmed active-bank calibration. Current forecasts refresh only when
unchanged live snapshots permit conditional writes. No old pull is replayed as a
new current event. Historical seed skips are shown in the report.

Limits: 10 MB uploaded ZIP; 2 MB uncompressed chat; one TXT per ZIP; 1,000 rows and
20 wells per server preview. Large exports can be split by date range.

Watchdog handoff: functions/src/imports/pullParser.ts is side-effect-free and shared.
Use parsePullChat(text,{defaultWell,timeZone,dateOrder,wellNames,defaultBbls}) and
findPullChatNotices(text). Integrate later through reviewed preview/apply, not a
second direct database writer. Event identity uses canonical well, UTC event time,
top feet and barrels, independent of file name/message ordinal. No watchdog code
or other application branch is changed in this release.

Verification: synthetic parser/model/callable tests, actual component rendered in
Chromium with mocked callables, private offline previews of supplied ZIPs, required
dashboard library regressions and certified Hosting preflight. Real messages and
private test artifacts are not committed.
