# Shift-based JSA source checkpoint — 2026-10-18

Status: source only. No APK build/install, Hosting release, Functions deployment, index deployment, or production JSA/HOS mutation in this change.

## Contract

One server-owned JSA work context per authenticated company/driver, independent of HOS clock-in. The first required job uses a full read and signature. Later required pickups use the shared acknowledgement and saved-document viewer. Per-job acknowledgements get a distinct stable JSA number; once-per-shift jobs reference the original read without inventing another acknowledgement. Multi-haul and split pickups remain individual jobs.

A pre-clock-in context attaches to the next verified shift without changing identity. Midnight never rotates it. Verified shift end finalizes the context automatically; an unavailable authority does not. Dates are original display metadata. A subsequent shift gets another context. Job completion uses the existing invoice close lifecycle: a signed read/acknowledgement is already completed evidence, with no separate manual JSA close ceremony.

Required reads remain governed requests bound to the exact job. Independent document authoring remains a separate workflow; its new signed records share context lifecycle metadata. Existing signed records are preserved, not rewritten as new governed completions.

## Implementation and rollout

Backend: persistent contexts, transactional creation/attachment, idempotent authority-change finalizer, context-bound receipts/acks/coverage, distinct per-job numbers, stop snapshots, saved-JSA references and weekly export metadata. Completed historical job evidence is retained. Existing pending requests without the new context are explicitly expired for a fresh registration; no historical completion is fabricated.

WB T: accepts and verifies the server context, shared View saved JSA link before later starts, shift wording, and saved links for once-per-shift covered jobs. WB JSA: read-only canonical history reconciliation recognizes legacy driverHash ownership and stable canonical IDs, updates the matching closed row instead of creating a second stale entry, and retains context/finalization metadata. Suite: Start Job owns the JSA requirement; clock-out no longer invokes the legacy extra read/recovery gate. DVIR and shift closure sequencing remain intact.

Before phone testing: deploy the scoped backend changes and added indexes, then build/install WB T, WB JSA and Suite together. Do not release the new context response to older WB T clients that reject it. Plan a coordinated rollout or add an explicit client-protocol gate first. No rules deployment is needed: a read-only audit of the currently deployed Firestore rules confirmed these new collections fall under the default deny. Never deploy the repository's stale rules.

## Older September 22 record

Read-only inspection of the authenticated driver's correctly hashed standalone history found the September 22 record already closed on the server. No production correction was required. The phone refresh now matches a legacy local row to that canonical record and carries its closed state and existing signed content forward. Exact on-device reconciliation still needs the next APK and phone verification. Private record details and audit output remain outside Git.

## Verification

Backend compilation and 48 JSA unit cases passed; 46 standalone server cases passed. Twelve local Firestore emulator checks covered concurrent creation, midnight, pre-shift attachment, end/new shift, signature-content preservation and owner isolation. The standalone full-flow emulator command was initially refused because no emulator was running; no production fallback was attempted. A separate local emulator then verified the new period store.

WB T bounded application typecheck and 16 runtime start/return/ack/coverage/account-isolation fixtures passed. JSA typecheck, standalone client boundary checks (including the stale closed legacy row), and owned open-list checks passed. Suite's 81 existing JSA/arrival checks passed. Suite's full typecheck reports errors in untouched AppSwitcher, SignaturePad and SettingsScreen code; it is not recorded as passing. Dashboard typecheck passed. Authenticated phone behavior and the deployed trigger have not been exercised.
