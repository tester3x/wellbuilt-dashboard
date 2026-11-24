# Combined audit verification and first containment batch

Status: source containment and read-only live metadata verification. Not a security release or a completed audit. No rules, Functions, Hosting, credentials or customer records were changed live during this audit.

Mike requested independent verification of the Claude/Antigravity findings and priority fixes. The supplied handoff is reference evidence; its source findings are not proof of exploitation. All checks used current registered laptop homes. Desktop Independent Dispatch work and other branches were preserved.

## Verified findings

| Handoff IDs | Verification | Disposition |
| --- | --- | --- |
| F-01/F-02/F-12; C-1/C-2 | Tickets Storage and Mobile RTDB local configs pointed to permissive rules. Dashboard default config also pointed at stale compatibility files despite its documented no-rules-deploy policy. | Added default predeploy refusal hooks in all three homes; existing Tickets Firestore refusal retained. Removed two tracked blanket Firebase deployment approvals from Tickets agent settings. No live rule publication. Custom/alternate deployment configurations still need explicit rules-owner review; these hooks are not an account-level security boundary. |
| Same rule findings, live comparison | Authenticated Rules API retrieved live releases/source; authenticated RTDB settings read retrieved rules only. Live Storage is company/driver scoped with direct operational client writes denied. Live RTDB root read/write are false. | The claim that the permissive app-local rules are currently live is not supported. Path-level live RTDB and Storage behavior still needs the full synthetic emulator matrix; root denial alone is not a full tenant-isolation proof. |
| F-09/F-20; C-2/H-6 | Live Firestore allows an owner-driver to update/delete `jsas`; the `jsa_read_receipts` compatibility exception allows unauthenticated shaped create and exact get, with list/update/delete denied. | Confirmed live rule defects; no unauthenticated customer record probe or write performed. Coordinated governed-client/receipt migration and immutable signed-record rules remain required. Do not abruptly deny legacy writes before migration acceptance. |
| F-09/F-20; C-2/H-6, related loss case | JSA `deleteJSAEverywhere` ignored the cloud helper's failed-result return, then removed local saved evidence; history also removed the row without checking success. | Staged client containment in JSA: saved-report deletion refused at UI/service/cloud helper, no local original removal. Standalone lifecycle Close remains governed and retains signed evidence. Three regression tests and TypeScript passed. Not built/installed; does not fix live authorization. |
| F-10/F-21; M-5/L-2 | Mobile tracked five operational exports, a bundled PIN account and a legacy admin bootstrap containing/logging a passcode. | Originals privately archived with integrity checks outside Git, exports removed from current tree and ignored, bundled PIN removed, anonymous legacy admin bootstrap disabled, hash example replaced with synthetic input. No history rewrite/rotation/live account edit. Historical exposure remains; coordinate credential inventory and targeted rotation/revocation. No credential values are included here. |
| F-03/F-05/F-06 | Current Tickets source has an anonymous allocation fallback and lacks the live catalog's top-level guard. Downloaded the ACTIVE functions' deployed source archives through the authenticated administrative source-download API and inspected their compiled handlers: live allocation first calls `requireDriverCaller` but still selects company from request/default; live catalog calls `requireDriverCaller` and applies a customer-company authorization helper. | Source/live divergence confirmed. Anonymous catalog/allocation findings do not describe these live handlers; live invoice caller-company attribution remains unresolved. Preserve shared NDIC catalog semantics. The deployed customer helper exempts staff broadly, so its staff tenant isolation also needs verification. Do not redeploy older laptop source wholesale. Allocation idempotency/client namespace and verified staff/company authorization remain migration work; no allocation was invoked as a probe. |
| H-4/H-5/M-4; F-07/F-20 | Reviewed advertised JSA security branch tip 7464d05e: tip itself changes login keyboard layout; preceding orphan-proof commits need isolated semantic comparison with current governed flow. | No wholesale merge or old-screen restoration. Native proof/owner/period/forced-refresh matrix still pending. |

## Fixes tested so far

- Tickets default rule deployment / agent permission tests: 3 passed.
- Mobile deployment and credential containment tests: 4 passed; retirement guard passed.
- Dashboard default database/Firestore/Storage refusal plus retained Functions/Hosting hook tests: 4 passed. No runtime/dashboard build needed for hooks.
- JSA evidence retention tests: 3 passed; TypeScript passed. These are source tests, not phone acceptance or server-rule emulator acceptance.
- Inspected installed Firebase CLI lifecycle implementation: it runs configured predeploy hooks for default, `--only` and targeted rule configurations. Synthetic tests execute the configured refusal commands without contacting Firebase.

## Offline evidence and remaining matrix

Earlier same-day S24 acceptance on Tickets458/JSA122 established a fresh shift, user-completed pre-trip and fresh JSA, offline Job Planner queued Start, then exactly one dispatch and linked invoice after reconnect/restart. Tickets459 separately fixed Route Me's omitted local company scope and server-first creation: S24 offline card appeared with Start/Cancel, Review worked, restart retained it, Cancel reconciled once without an invoice. This is narrow acceptance, not completion of the audit's full field matrix.

NOT RUN for the audit: weak/intermittent transport and lost acknowledgments at every Arrive/Depart/Close boundary; multiple completed split/multi-haul/photo queues with interrupted replay; A-to-B-to-A account/company switching and legacy quarantine; genuine revocation versus network failure; device reboot/storage-failure acceptance across all apps; full rules allow/deny emulator matrix; post-migration S24/Fold acceptance. No manual screen work while driving is required.

## Next coordinated release priority

1. Establish the exact deployed owner/source for affected allocation/catalog endpoints. Add synthetic anonymous/forged-company/identical-name tests before changing them; make reservations owner-bound and idempotent, including client cache namespace and migration.
2. Replace compatibility receipt and legacy evidence mutations with authenticated governed operations, verified claims and immutable owner/period/record bindings. Preserve local originals and stable replay IDs; quarantine ambiguous legacy ownership rather than reassign it.
3. Stage the immutable signed-record and authenticated receipt rules against migrated clients. Test deny-by-default, cross-tenant, immutable update/delete, idempotent receipts and legitimate offline upload/recovery in emulators before any coordinated rules publication.
4. S24 canary first, Fold only after acceptance, preserving existing work. No blanket rule closure, mass logout, credential rotation, history rewrite or production deployment is included in this source checkpoint.

Rollback must preserve queued originals and signed artifacts. Do not roll back security by publishing the permissive local rules. Return to the last verified client only with compatible backend contracts and retained queue/evidence state.

Private rule metadata/source snapshots, artifact originals and operational test evidence remain outside Git under the laptop release-artifact directory. No customer record sampling was used for this audit. Other-machine unpushed work cannot be discovered.
