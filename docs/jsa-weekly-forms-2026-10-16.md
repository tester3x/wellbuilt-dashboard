# Historical JSA forms export for TicketTime

Adds `jsaWeeklyForms` as a new read-only callable. Existing JSA authentication and audience are required. Driver/company come exclusively from claims; request accepts only date range and timezone. No active shift is required to read the owner's historical forms. No request creation/completion, inspection, HOS or payroll changes, and no rules or Hosting changes.

Confirmed governed receipts are joined to owned signed artifacts; absent artifacts are disclosed. Legacy signed JSAs and standalone signed records remain separate sources. WB T server job acknowledgements retain their method, job and exact period, and reference the earliest qualifying full read in that same shift. A date-only association is never authority. Original step text not archived by older governed artifacts is not invented as original content by the JSA renderer.

Validation: 10 focused tests passed; Functions typecheck passed. This checkpoint does not deploy the callable. Release only `functions:jsaWeeklyForms`, independently of desktop's Hosting/demo work, with companion JSA, WB E and TicketTime source updates. All source/next-build coordination is documented in TicketTime `docs/weekly-work-forms-2026-10-16.md`.

Deployment follow-up: the user subsequently authorized the endpoint release. It is now ACTIVE; see `docs/jsa-weekly-forms-deploy-2026-10-16.md` for the exact source, deployment command, hash and live verification. No app build or Hosting deployment was performed.
