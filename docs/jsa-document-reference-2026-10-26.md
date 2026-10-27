# Signed JSA document references — 2026-10-26

Read once followed by job acknowledgements uses the signed full read's single document number. Separate acknowledgements retain their own immutable receipt IDs, job links and original times. Separately signed full reads retain separate numbers. No policy requirements or shift/context authority changes.

The online and prepared-offline acknowledgement writers now copy the number from the exact qualifying signed read. Read-only shift, saved-job and weekly projections also resolve that signed read's number instead of displaying historical per-acknowledgement numbers. Existing historical records are not rewritten. The shift summary still counts signed reads, acknowledgements and unique jobs separately, including signed evidence for later-canceled jobs.

Source lane starts from the preserved offline-JSA source checkpoint 059e2764, with the tested numbering change carried from its earlier source checkpoint. Functions TypeScript build and 91 tests across numbering, shift summary, saved jobs, weekly forms, policy and offline validation pass. The compiled callable also passes the isolated demo Firestore emulator with concurrent retries, immutable IDs, preserved acknowledgement time and shared signed-document numbering.

Deployment preparation uses each affected callable's own downloaded live source, not a broad functions/rules release. Downloaded live modules show older raw-number projections; preserve their authentication and lookup logic while applying only reference changes. No real load, signature, JSA receipt or HOS record has been authored or edited for testing.

## Scoped deployment and read-back

Deployed only jsaAcknowledgeJobShift, jsaOfflineShift, jsaShiftSummary, jsaGetSavedJob and jsaWeeklyForms from separately audited copies of their live archives. Changed only each relevant numbering module plus the shared number helper and accompanying source/maps. The online archive retains its existing jobDayDeps export shape; no unrelated endpoint, Hosting, security rule, policy, authority or runtime configuration was deployed. Source checkpoint c80ad349047e4fd6e5545c931aee871fedd407fe.

All five report ACTIVE. Active resolved-source archives byte-match their full audited upload packages. Revisions: jsaacknowledgejobshift-00003-juf, jsaofflineshift-00005-beb, jsashiftsummary-00002-yep, jsagetsavedjob-00004-jid, jsaweeklyforms-00005-zet. Signed-out requests remain rejected (401 for the four existing readers/online writer, the offline endpoint's existing driver_session_required 403). Deployment evidence and package/file hashes are private outside Git.

Read-only execution of the active downloaded shift-summary module against the owner's exact completed shift returns one signed document reference, one full read, four acknowledgements and five unique jobs with evidence. The active saved-job reader independently resolves all four acknowledged jobs to that same signed reference. Every underlying period, governed request, acknowledgement and coverage record exactly matches the pre-change audit; no historical evidence was mutated. The extra job is a canceled pre-shift signed-read job, not a duplicate physical load.

Suite source 8c6573f shows the final six digits, with singular/plural labeling and all distinct signed-document numbers. Its eleven focused tests pass. No new Suite/JSA/WB T APK was built or installed in this change. Existing installed clients receive the corrected shared server reference; the compact Suite rendering needs its next APK. Shared cross-app Shift numbering remains a separate documented feature.
