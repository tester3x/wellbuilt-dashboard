# JSA work-period continuity

Owner-approved policy: each new shift requires a fresh JSA and finalizes any
open off-shift period. An off-shift JSA can cover subsequent jobs for fourteen
elapsed hours from its period creation. Activity, midnight and calendar dates do
not reset that clock. At exactly fourteen hours, the next job creates a fresh
period and finalizes the old one. A shift ending cannot resurrect an earlier
off-shift period.

Closures are lifecycle metadata, with observed closure timestamp and an explicit
shift_started, shift_ended, shift_replaced or off_shift_window_expired reason.
They do not rewrite signatures or invent the driver's actual work-end time.
Normal active-job coverage checks suppress elapsed-window rollover. The home
view stops offering an expired period as Resume without mutating its history;
the next required new JSA performs the transactional replacement.

This is a JSA policy, not an HOS enforcement change. Unknown shift authority never
closes the existing period. No production clock override was added. Tests inject
time into the pure decision model and freeze the clock around store tests.

Reconciliation: deployed transition/evidence/standalone functions still used the
older October attachment behavior. Home had the newer November off-shift Resume
behavior. Isolated prior fixes 2412e5b0, f42e2280, 801e18d7 and 48d54e82 were
integrated into the current registered Dashboard home, preserving Watchdog and
job-exception changes. Compiled live dependency comparisons were reviewed before
the scoped release. Existing operator projection and JSA-number behavior remain.

Validation: TypeScript build; all 11 JSA unit suites / 120 tests; governed receipt
matrix 142 checks. Boundaries include just before / exactly at / after fourteen
hours, midnight, seven hours working plus seven stopped, short job turnaround,
twelve-hour jobs followed by another load, shift transitions, unavailable shift
authority, repeated resolution returning one new period, and unchanged signed
artifacts. No actual shift, job or signed JSA was advanced for simulated testing.

Both installed test apps (Tickets 414 and JSA 120 on S24) already call these
server endpoints. No app UI/native code changed in this server release, so an
APK rebuild would not contain the new authority rule. Device end-to-end testing
remains distinct from the simulated-clock tests. No current real job was closed
or signed by this change, and no historical period was manually repaired.

## Deployment

Source c2511cba0ec02dbf462f53737b776902281ce772 was committed, pushed,
freshly fetched and built clean before scoped deployment. Independently verified
ACTIVE after deployment: jsaFinalizeShiftContext, jsaResolveJobShiftEvidence,
jsaRegisterJobShiftReadRequest, jsaAcknowledgeJobShift,
jsaRecordJobShiftReadCoverage, jsaHomeState and jsaStandalone. All seven report
Node22 and Firebase source hash eea6a2e536306dc28d2430d385f92ea6c8d5d844.
No Hosting, rules, HOS/shift functions or unrelated Functions were deployed.

Tickets414 and JSA120 were read back from S24 using ADB; no install or UI action
was necessary for the server release. Real device shift transitions and the
long-duration observation remain to be tested. No device end-to-end pass is
claimed from the simulated-clock or store tests. The change is prospective;
an earlier already-attached period was not manually unlinked or rewritten.
