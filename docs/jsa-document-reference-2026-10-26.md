# Signed JSA document references — 2026-10-26

Read once followed by job acknowledgements uses the signed full read's single document number. Separate acknowledgements retain their own immutable receipt IDs, job links and original times. Separately signed full reads retain separate numbers. No policy requirements or shift/context authority changes.

The online and prepared-offline acknowledgement writers now copy the number from the exact qualifying signed read. Read-only shift, saved-job and weekly projections also resolve that signed read's number instead of displaying historical per-acknowledgement numbers. Existing historical records are not rewritten. The shift summary still counts signed reads, acknowledgements and unique jobs separately, including signed evidence for later-canceled jobs.

Source lane starts from the preserved offline-JSA source checkpoint 059e2764, with the tested numbering change carried from its earlier source checkpoint. Functions TypeScript build and 91 tests across numbering, shift summary, saved jobs, weekly forms, policy and offline validation pass. The compiled callable also passes the isolated demo Firestore emulator with concurrent retries, immutable IDs, preserved acknowledgement time and shared signed-document numbering.

Deployment preparation uses each affected callable's own downloaded live source, not a broad functions/rules release. Downloaded live modules show older raw-number projections; preserve their authentication and lookup logic while applying only reference changes. No real load, signature, JSA receipt or HOS record has been authored or edited for testing.
