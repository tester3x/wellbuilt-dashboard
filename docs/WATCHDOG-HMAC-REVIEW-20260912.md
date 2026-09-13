# Endpoint-scoped Watchdog: canonical processing gate failed

## Source lineage

Isolated branch feat/watchdog-hmac-ingest-20260912 starts at
2b83044a4bfd8af5d5fd968f8ce73dab0c216503. The actual live wellbuilt-sync
processIncomingPull archive (updated 2026-09-12T02:29:19.709Z) was downloaded via
the Cloud Functions v1 generateDownloadUrl API. Its src tree matches this base,
and rebuilding this base produces a lib/index.js matching the deployed JavaScript
(Git comparison ignores line-ending differences). No processor source changed.

Reviewed AntiGravity feature/watchdog-ingest-secure-20260913 at
028c6d4fd4cd0320bf240afdd55a97602c7d685d. No whole commit cherry-pick, Firebase
principal provisioning, callable deployment, or rule deployment occurred.

## Reused work and corrections found

The diagnostic test reuses AntiGravity's two Kahuna observations, 10-tank fixture,
canonical processor checks, receipt expectations and commercial-isolation checks.
The second packet ID is corrected to 20260912_174800_Kahuna5_aef41b. It stops
on the first canonical failure instead of accepting an early processed row.

Review findings in AntiGravity's source:

- Ingest uses Firebase Auth kind=watchdog and client token company claims; replace
  with endpoint-scoped HMAC and a server-fixed principal/company mapping.
- Sequential reads followed by set are not atomic idempotency. Payload conflicts
  and alternate-ID representations of the same observation need durable checks.
- Receipt authorization is company-only and permits missing company metadata;
  require a server ledger proving this exact integration submitted the packet.
- Receipt does not check outgoing; require matching packet identity plus canonical
  completion/current-state evidence, without returning unrelated newer packet data.
- Remove authoritative wellDown flags and synthetic driverName. Do not fabricate
  a driver identity to satisfy existing processor fields.
- Tighten validation to one allowlisted observation shape, required bottom/digest,
  unambiguous units and Chicago event-time correspondence. Existing aliases and
  optional provenance are not sufficient for the assigned strict contract.

## Failed emulator gate

Command from this worktree (config lives with evidence):

    firebase emulators:exec --config C:/dev/output/watchdog-wbm-20260912/firebase.json --only database,firestore --project demo-watchdog-canonical "node functions/tools/test-watchdog-canonical-gate.cjs"

TypeScript build passed. The diagnostic executes the real exported
processIncomingPull.run against isolated RTDB/Firestore emulators, not a mocked
processing algorithm. No Functions trigger duplication is involved.

Event A (AntiGravity's decimal-feet fixture): top 7.5, verified bottom 6.7, BBL 150,
10 tanks. Existing canonical code computes top - BBL/(20*tanks) = 6.75 feet:

- processed tankAfterInches: 81; required observed bottom: 80.4 inches.
- no canonicalProcessingComplete marker.
- no outgoing response or current well status.
- processor timed out at 30 seconds after its owner-materialization retry log.
- empty tickets, invoices, payroll, billing, billing_invoices, dispatches,
  jsa_day_status collections.
- Event B was deliberately not attempted after Event A failed the gate.
- zero production writes; neither real Kahuna packet was sent.

Evidence log: C:/dev/output/watchdog-wbm-20260912/canonical-gate-final.log.
This is a FAILED acceptance gate, not a passing end-to-end suite. The same missing
outgoing/status and 81-inch processed result were independently read via emulator
REST. The test uses decimal feet exactly as AntiGravity's fixture; the production
client contract must explicitly resolve units rather than infer them from notation.

AntiGravity's ServerValue fallback is later in the handler than this stall. Its
literal {'.sv':'timestamp'} is an RTDB server timestamp sentinel, but deploying
that edit would modify processIncomingPull and does not make verified bottom
authoritative. No processor patch was copied or deployed.

## Proposed endpoint/client contract — NOT implemented or active

Only ingestWatchdogPull and getWatchdogPullReceipt would accept this credential.
POST JSON over HTTPS, bounded raw UTF-8 body, key ID / timestamp / nonce /
HMAC-SHA256 signature headers. Sign a versioned string including exact endpoint
name, method, timestamp, nonce and SHA-256(raw body), preventing cross-endpoint
reuse. Fresh nonce per retry; durable nonce rejection and rate limit per principal.
Durable semantic observation digest deduplicates alternate packet IDs; body digest
conflicts fail closed. Receipts require the principal-owned submission ledger.

Server-only binding: principalId=wb-rnd-watchdog, principalOwner=wellbuilt,
actingForCompany=liquid-gold, source=whatsapp_watchdog, environment=rnd.
Reject all supplied company, driver, wellDown and commercial context fields.
Keep chat/sender evidence in the integration ledger outside commercial records.

Server key: dedicated Google Secret Manager secret, versioned key IDs for rotation.
Client key: Windows Credential Manager or user-scoped DPAPI, available only to the
Watchdog service account. No Firebase UID/SDK/ID token, Admin key, CLI token or
browser credential. Provisioning would stream generated secret bytes directly to
Secret Manager and OS-protected storage, without plaintext disk/log/report output.
No secret or client storage was created. No endpoint exists from this work.

## Exact activation prerequisites

1. Resolve the canonical driverless materialization failure and provide an approved
   canonical input path where verified bottom is authoritative. Do not fake top,
   BBL or tank configuration. Current authorization permits only new endpoint
   deployment, not replacement of processIncomingPull.
2. Verify any corrected processor's deployed lineage, then finish endpoint HMAC,
   replay/rotation/idempotency, strict validation and exact-principal receipt tests.
3. Prove BOTH events through processed/outgoing/current-well completion and prove
   HMAC grants no Firebase database or unrelated-endpoint access.
4. Deploy exact new endpoints only, provision the scoped secret through protected
   storage, give Grok the final versioned wire contract and key identifier (no key
   in the handoff text).
5. Keep transport OFF until Grok's real-world stop control and final duplicate
   preflight are cleared. Separate authorization is required to send the real pulls.

WB-E files, installed Suite 47 / Equipment 26, accounts and inspection state were
not changed. Combined Pre/Post report viewing remains next before JSA.
