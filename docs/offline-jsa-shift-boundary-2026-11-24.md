# Offline JSA endpoint lifecycle reconciliation

S24 acceptance of Tickets458 exposed that the live `jsaOfflineShift` deployment still bundled the older October27 work-period implementation. It attached an existing off-shift period to a new shift, even though the current shared lifecycle starts a fresh period on every shift and expires off-shift periods after fourteen elapsed hours. No test job was started and no old JSA was acknowledged by the agent.

The registered release branch lacked the five offline-domain modules still running in that endpoint. Integrated only those isolated live-domain source modules and their three existing test suites from `c80ad349047e4fd6e5545c931aee871fedd407fe`, plus the signed-read number helper, preserving the current work-period store/policy, current auth and packet verification. No UI, historical branch merge or old work-period implementation was restored. Exported the existing current `jobDayDeps` adapter so the offline callable uses the same current policy as online JSA.

Preparation also explicitly rejects completed reads from another owner, JSA period or associated shift. This prevents an old read qualifying even if older metadata had promoted a period. Current-shift reads still work across midnight; no calendar-day expiration was added.

57 targeted tests cover offline signed evidence/replay/location projection, verified execution profiles, fresh clock-in boundaries, fourteen elapsed hours, immutable signed snapshots, same-shift midnight continuity and the new read fence. Functions TypeScript build passed.

Deploy only `dashboard:jsaOfflineShift`, then verify its uploaded source and compiled lifecycle against this committed source. No Hosting, rules, HOS edits, signed JSA changes, old record migration or Fold interaction. The already-contaminated S24 test period is ended through the normal user-reviewed shift/DVIR flow; a subsequent new shift is required for clean fresh-period device acceptance. Device test is not yet a pass.
