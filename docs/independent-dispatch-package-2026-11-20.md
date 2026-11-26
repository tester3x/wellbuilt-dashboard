# Independent Dispatch — Dashboard package setup

Independent Dispatch is an operational job package, alongside Water Hauling,
Aggregate, LTL and Hot Shot. It is not a subscription tier and installing it
does not change a company's existing packages, billing, or driver identities.

## Entry points

- Settings → Job Packages → Independent Dispatch → install.
- Installed package card → Open Independent Dispatch.
- Dispatch workspace → Independent Dispatch.
- Dedicated board: `/dispatch/independent`.

The public catalog definition is `src/lib/independent-dispatch-catalog.json`.
The settings card discovers this built-in entry if the shared catalog has not
yet been seeded; an existing catalog record takes precedence. The scoped
publisher is dry-run by default and creates only
`job_packages/independent-dispatch`; it refuses to overwrite a different entry.
It never activates the package for a company automatically.

## Job workflow

Create a job with its customer, reference, pickup, destination, cargo/quantity,
optional local pickup schedule and instructions. Save it before assignment.
Add outside-driver contacts, then assign/reassign before work starts. Staff can
mark an assigned job started, mark started work completed, or cancel an active
job. Completed/cancelled jobs remain searchable; they cannot be silently
reopened or edited. The active filter excludes those terminal jobs.

Records live in `independent_dispatch_jobs`, separate from water-hauling
dispatches. Every mutation creates an immutable event with actor, revision,
timestamp and status transition. The callable derives company from trusted
staff authority, rechecks package activation inside its transaction, enforces
optimistic revision checks and exact-payload retry idempotency. Assignment
requires an active company-bound outside-driver contact. All reads require
`viewDispatch`; writes require `createDispatch`; assignment/contact management
also require `manageDrivers`.

## Boundaries and next phone-app stage

This board records staff progress. It does not claim driver acceptance, send
SMS/WhatsApp, generate water tickets, write WB-M execution, or grant cross-company
driver access. The existing water-hauling and external-delivery lanes remain
available. WB Dispatch phone support must explicitly consume this job model and
add authenticated job acknowledgements; it must not infer authority from a phone
number or external contact. Existing guest links still refer to native dispatch
deliveries; these new jobs do not pretend to use that transport.

## Verification

- Functions TypeScript compile.
- Focused Jest tests: validation, lifecycle, trusted package/tenant boundaries,
  idempotency conflicts, stale revisions, driver eligibility and retained audit.
- Actual React board browser regression at 1280px and 390px: create, assign,
  start, complete, filter and terminal locking, with transport fixtures.
- Dashboard typecheck and mandatory Hosting preflight before release.

Only `staffIndependentDispatchJobs` and the existing
`staffExternalAssignmentDelivery` (for contacts/access) are in this release's
Functions scope. Do not deploy all Functions, database/Firestore/Storage rules,
guest endpoints, Watchdog, JSA or other apps as a side effect.
