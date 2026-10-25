# Active-job saved JSA reader — 2026-10-18

Adds jsaGetSavedJob, a read-only WB T callable. It verifies WBT driver claims and invoice ownership, resolves the exact job acknowledgement/direct full read/scope coverage, and returns only allowlisted signed snapshot fields. Older acknowledgements resolve a full read from the same verified shift, preceding the acknowledgement; explicit references never fall back to another read. No shift or current-policy requirement and no data mutations. Missing signed content is disclosed separately from a saved acknowledgement.

Validation: Functions TypeScript build passed; saved-job and existing weekly-form tests 22/22. Client checks in WB T cover job/company/driver/account changes. No rules or hosting changes. New native app code still needs a future APK; no APK requested for this change. Server deployment status will be recorded after deployment.

Deployed only functions:dashboard:jsaGetSavedJob from source 4fb148bd. Live ACTIVE revision jsagetsavedjob-00001-ded, updated 2026-10-18T20:22:24Z (3:22 PM CDT). Signed-out live callable probe returns 401 UNAUTHENTICATED. Read-only local execution of the same handler against the reported open job resolved its saved acknowledgement and signed full-read artifact. Authenticated phone UI remains to verify after a future APK. No rules/hosting deployment or load/JSA/HOS mutations.
