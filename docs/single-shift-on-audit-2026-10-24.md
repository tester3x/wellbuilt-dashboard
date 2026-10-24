# Existing ON projection audit

Audited every configured production well with an outgoing projection and no
explicit AFR-only policy, excluding demo/test routes. Compared canonical history
boundaries, recorded bottoms, calibrated bank size and actual elapsed Central
date intervals with the outgoing ON value and inferred-time marker. Independently
checked the arithmetic for every valid pair.

Seventy-five production-well projections were checked. Fourteen have valid
consecutive-day pairs, including thirteen with activity within seven days; all
fourteen already matched. Forty-three legacy values instead represented gaps
across multiple days. Cleared only their ON value/marker through the deployed,
guarded refresh path so Mobile falls back to its unchanged AFR. Sixteen were
recent records and twenty-seven were older records. Remaining absent ON values
are consistent with missing endpoints, nonconsecutive dates, down state or
provisional evidence. An unverified first endpoint remains withheld.

After a fresh second audit all seventy-five ON values/markers match the rule.
Readback verifies original processed history, well status, AFR and configuration
are unchanged. A normal incoming revision notifies Mobile. No new APK or backend
deployment was needed beyond source `733520c7`; build 101 already handles explicit
estimate withdrawal.

Two unrelated historical projections have identity/date inconsistencies but
already have no ON value; no original timestamps were altered in this audit.
Private details, backups and per-well endpoints are outside Git. The ZFold was
outside Mobile during the final check, so foreground screen controls were left
alone. Final acceptance here is live projection readback plus the existing
response/withdrawal integration coverage, not a new phone screenshot.
