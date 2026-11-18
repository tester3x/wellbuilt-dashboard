# Resume the current off-shift JSA from home

The completed S24 test job retained its open off-shift JSA correctly. The separate End JSA card detected the active work period, but the home status callable deliberately returned New JSA whenever HOS was off shift. This made the screen contradictory and prevented Resume.

Home now resolves only the owner's current active work-period pointer when off shift. It requires an open period with no shift binding and resumes signed reads or standalone records bound to that exact period. Finalized, foreign, shift-bound, unbound and previous-period records cannot supply off-shift Resume. Period lookup and home read perform no lifecycle writes. On-shift selection remains scoped to the actual authoritative shift.

Off-shift queries omit empty shift filters and use exact JSA-period identities with company/driver ownership filters and existing size bounds. The matching client validates this binding and uses one shared status for its primary action, status copy and End JSA card.

Checks: Functions TypeScript build; home/preview/work-period/summary tests 49/49. A read-only replay of the current real S24 test data produced Resume, shiftState none, matching original signature, with the job closed and JSA period still open. This replay did not change records. Deployment/phone verification will be recorded after release.
