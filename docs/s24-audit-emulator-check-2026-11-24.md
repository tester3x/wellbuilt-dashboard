# S24 isolated emulator acceptance checkpoint

User authorized S24 testing with local emulators, preserving signed/pending work, leaving Fold alone and no deployment.

## Tested source and boundaries

- Dashboard source: 47ca1113cbb5e1ea1fed16b2d7746e929752b1cd.
- JSA source: 2b40881b02ce248db8ac1a0516d0837d3b97196a. `services/legacyEvidence.ts` SHA256 e242277f4b781bec1b265f6be19250b88f8d76509479797ae22c90a5cf0b2692.
- Tickets source: 26f845b42358df5866956444f288ccdb0731630d. `utils/invoiceAllocation.ts` SHA256 a5371217afca98c73bc41855abc8e253ebc88aac35707f6944253fb52bae16ba.
- S24 Chrome executed the exact transpiled client modules against synthetic Auth, Firestore and RTDB emulators in `demo-wb-audit-s24`, through USB loopback forwarding. Server verified emulator ID tokens and invoked the actual JSA callable `.run` wrapper (including canonical driver membership and rate limit). The invoice adapter was extracted/evaluated from its exact reviewed export to avoid loading unrelated Functions exports.
- The HTTP adapter is a test bridge, not a Firebase Functions emulator. Client dependency adapters substitute synthetic sessions/transport and browser IndexedDB for native AsyncStorage. This validates on-device JavaScript, durable browser state and authenticated backend behavior; **it does not establish native app UI, Hermes, AsyncStorage or full installed-app acceptance**.
- Installed Tickets459 and JSA122 were read back unchanged. No app replaced, account switched in a production app, app data cleared, real signed record changed or pending production item deleted. Fold was not operated. No production endpoint or rules deployment occurred.

## Results

Four offline checks passed: failed delivery did not claim success; no archive transport call; signed original unchanged; pending marker retained. S24 Wi-Fi/mobile data were disabled for the initial save and restored to their original enabled state afterward. USB loopback remained connected; an explicit offline adapter denied cloud operations. This is not an independent native network-detection test.

After page restart, 20 further checks passed:

- Original/pending state survived restart. A bounded error injected after receipt commit left the retry pending; identical replay confirmed the same receipt without changing signature/time.
- Company B could neither adopt A's local signed original nor read A's receipt. A response crossing an account switch did not confirm A's upload. Returning to A recovered it.
- A's cached number block worked without transport. B saw no A cache and received B attribution. Forged company allocation was rejected. A to B to A retained consumed progress; replaying older cache progress could not roll it back.
- Emulator proof: exactly one unchanged signed record, exactly one original-time receipt, exactly one company-A invoice block.

Initial harness fault: a raw socket close after commit was transparently retried by Chrome, so JavaScript did not observe a lost response. Changed injection to a deterministic HTTP 503 after commit and reran. That is a test-harness correction, not an application fix. The two final server refusal counts were the expected foreign-receipt and forged-company denials.

## Separate S24 stuck test job

User identified `SA RECOVERY TEST`, not paused Burger 1. Its normal Cancel was reproduced: `The saved job identity could not be verified.` Source trace reaches `queuedDispatchRecord` before cancellation enqueue. That combined validator checks current owner, published package/revision and other start requirements. The exact failed condition remains unproven without the recovery census; do not infer or reassign the old record's owner, clear the outbox, or remove the other job. User was asked to export recovery census to Downloads for read-only inspection. No cancellation was confirmed and the test job remains retained.

Native S24 acceptance and the stuck-job recovery remain outstanding. Do not treat this checkpoint as release approval. Private device UI/log evidence stays outside Git in the laptop release-artifact directory.
