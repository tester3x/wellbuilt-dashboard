# Watchdog ingestion assessment — stopped at scope boundary

## Consolidated R&D request recheck (supersedes prior identity proposal)

On 2026-09-13 at 00:30 UTC, downloaded the live wellbuilt-sync rules again and
reran ten emulator assertions using synthetic UID wb-rnd-watchdog with claims:
kind=internal_integration, principalOwner=wellbuilt,
integrationId=wb-rnd-watchdog, environment=rnd,
capabilities=[wbm.pull.ingest,wbm.pull.receipt]. No driver, employee, customer,
staff or administrator claims or records were supplied. These are emulator-only
claims, not a provisioned production identity or a finalized endpoint contract.

The same three direct reads below are permitted. Seven prohibited/unauthenticated
operations were denied. Thus the literal zero-direct-database-access gate FAILS.
Changing identity type or adding narrower callable checks cannot subtract these
existing rules permissions. The consolidated request prohibits security-rule
deployments during this task, including narrowing changes. Stop before endpoint
deployment and identity/credential provisioning.

Preferred design remains a separate ingestWatchdogPull wrapper and own-packet
receipt callable (proposed name getWatchdogPullReceipt), using the existing
canonical WB-M incoming path with server-controlled liquid-gold targeting and
distinct integration provenance. Neither function was implemented or deployed.
Full pipeline/outgoing/current-well/duplicate tests were not run or claimed.
No production UID exists from this task. Renewable unattended Firebase auth with
a DPAPI/Windows Credential Manager protected refresh credential is the intended
storage model, but no credential mechanism was installed or provisioned.

Evidence: test-rnd-current-rules.cjs, rnd-rule-test-results.json, rnd-emulator.log
and freshly read lineage.json under C:/dev/output/watchdog-wbm-20260912.
Zero production pull writes; both specified Kahuna 5 observations remain unsent.
No WB-E source, installed build, account, inspection or shift state changed during
this recheck. Watchdog work is stopped at the requested gate; return to the WB-E
combined-report follow-up before JSA.

The original assessment below is retained as history; its proposed Watchdog
identity is superseded by the internal_integration identity above.

Isolated branch: assess/watchdog-wbm-ingest-20260912, based on
origin/security/database-containment at ca4afa497f2514087c1f0003e3852b890928605a.
No application or security implementation files changed.

The existing ingestWbmPull is driver-only: requireSecureDriver, canonical active
driver/profile and company/well scope checks, driverId/driverName stamping.
It cannot accept the requested non-driver Watchdog identity unchanged. A thin
wrapper can reuse evaluateWbmPull and packets/incoming/{canonicalPacketId}; it
must not duplicate processIncomingPull. End-to-end compatibility has not been
proven because the prerequisite below fails.

Live project wellbuilt-sync was read on 2026-09-13 UTC (Sep 12 local).
ingestWbmPull ACTIVE, updated 2026-08-22T23:36:44.497948208Z.
processIncomingPull ACTIVE, updated 2026-09-12T02:29:19.709Z.
Firestore rules release last updated 2026-08-21T03:25:11.821976Z.

## Exact collision

The requested dedicated Firebase-authenticated principal would inherit these
existing direct reads regardless of its Watchdog capability:

- RTDB packets/incoming_version: .read = auth != null.
- Firestore staff/{uid}: signedIn() && request.auth.uid == uid.
- Firestore platform_admins/{uid}: signedIn() && request.auth.uid == uid.

The Firestore probes read empty self paths, not existing staff/admin records;
they demonstrate permission, not staff membership or administrative authority.
Meeting the literal no-direct-RTDB/Firestore-permission requirement therefore
requires shared rule changes. User explicitly required stopping for broader
security changes, rather than forcing them into the callable-only work.

## Emulator evidence

Downloaded live rules loaded through initializeTestEnvironment in isolated demo
project demo-watchdog-assessment, ports 19021 / 18021. Ten assertions passed:
unauthenticated incoming-version read denied; Watchdog incoming write, processed
read, outgoing read, well-config read, Firestore ticket write and company read
denied; the three direct reads above allowed. Synthetic Watchdog claims used
kind=watchdog, capabilities=[wbm.pull.ingest], watchdogCompany=liquid-gold, with no
driver or human staff/admin identity.

Evidence: C:/dev/output/watchdog-wbm-20260912/{lineage.json,database.rules.json,
firestore.rules,test-current-rules.cjs,rule-test-results.json,emulator.log}.
No production packet was submitted. Authorized-through-processed receipt,
duplicate, future/cross-company and zero-commercial-side-effect pipeline tests
are NOT claimed: no endpoint was implemented.

## Handoff

No Watchdog-specific branch was found in fetched dashboard remotes or local
worktrees; AntiGravity's unpublished work remains unverified. Reuse it if supplied.
No new or changed function deployed. No Watchdog Firebase identity, claims or
desktop renewable credential provisioned. No service-account key installed.
After the scope boundary is resolved, provision a dedicated non-driver principal
and a securely stored refreshable Firebase credential; transport must stay off
until the endpoint, canonical processing, idempotency and own-packet receipt are
proven. Neither 16:57 nor 17:48 Kahuna 5 pull was sent.

WB-E checkpoint before this assessment: Suite 47 / Equipment 26 on both phones;
ordinary app sign-on and cold restore verified for the owning accounts. Both
shifts remain closed, Pre/Post markers complete. Watchdog assessment did not
touch WB-E files or phone state. Combined Pre/Post report viewing remains queued.
