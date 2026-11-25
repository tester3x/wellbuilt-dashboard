# Cloud activity monitor laptop verification - 2026-11-24

Implemented a read-only local panel using Google Cloud Monitoring metrics, not a
new Firestore trigger. Four metric types collected once per minute; browser reads
only aggregate local snapshots. No cloud writes, load delivery or shutdown action.

Verified Chrome's Float monitor action created its own Document Picture-in-Picture
window, showing live metrics after returning focus to Codex. Parent browser tab
must stay open. Latest observed sample: 8:12 PM Central, photo fallback 2/min,
Firestore 41 reads/min and 34 writes/min; normal. This is delayed platform activity,
not proof of a new photo receipt or a billing estimate.

Six automated tests passed: aggregation, loop-sized alarm with culprit, Gen2
metric de-duplication, unknown/stale handling, Firestore burst, and loopback HTTP
read-only/origin restrictions. Visual live panel verified; synthetic alarm logic
was tested automatically, not claimed as a physical sound test. Sound remains off.

Native Windows prototype compiled but Application Control blocked execution.
No policy bypass or security change. Supported launcher now opens the local
browser panel using installed Node and browser. No startup task, provider-side
alert policy or external notification channel has been configured. Closing the
browser leaves the collector to exit after ten minutes without local polling.

Code is suitable for another machine using its own Firebase CLI sign-in; desktop
and OD installation are not yet verified. No credentials or artifacts committed.
The separate next-real-Dwyer-photo watcher remains pending: no new photo event
observed by this verification. No historical resend.

## Local alert verification

Added a Test alert control. It shows a clearly marked fake 1,275/min critical
warning for ten seconds and plays the same beep used by real critical alerts.
It does not change the collector snapshot, invoke a cloud function or resend.
Verified red FAKE SPIKE in Chrome's floating window; Mike confirmed hearing the
beep. Verified automatic return to live afterward with Sound on. No external
notification channels configured. Six monitor tests still pass.
