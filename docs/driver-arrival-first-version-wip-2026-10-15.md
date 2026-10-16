# Driver arrival recommendations — WIP checkpoint

Branch: release/dashboard-compact-identity-20261015. Baseline 77526787.
Local date: October 15, 2026, America/Chicago.

## Authorized scope

Check live data coverage and implement advisory pickup-arrival ranking with
explanations. Preserve all currently selectable drivers, ordinary assignment
controls and company boundaries. No automatic selection, assignment or queue edit.

The user requested a cost discussion before deciding whether to enable Google
APIs. API activation is NOT authorized yet. No Google service/billing/quota or
credentials changed. No new road-time calls are wired into the product.

User follow-up: recorded drive times must be consulted FIRST. Implemented and
regression-tested: three clean recent same-direction trips with matching endpoints
use their median without calling the road provider. Insufficient or reverse-only
history may consult an explicitly supplied provider; none is enabled in production.
Google lookup results are not being stored as our recorded-trip history.

User follow-up: only the drivers actually working that day should generate travel
comparisons. Existing canonical open-shift authority is the active-comparison gate;
persistent login/account existence is not presence. Panel now shows the on-shift
comparison count. Regression explicitly proves off-shift/unverifiable accounts
perform zero external travel lookups while remaining in the selectable results.

CORRECTION: the user clarified that other drivers use WB account login without
starting WB-S/WB-T shifts. Removed the shift gate and on-shift comparison count.
Shift dots remain informational on existing controls. Unknown presence is not
logged-out. Explicit logged-out evidence may withhold a travel estimate; usable
recent work/location can still support one without a shift start. Tests updated.

Presence audit: governed Dashboard catalog does NOT expose reliable account
presence. WB-M has old lastLoginAt company-device tracking behind
DEVICE_MANAGEMENT_AVAILABLE, with no call sites found in the inspected login
file; manual logout clears its local auth/session, not a shared presence flag.
Suite logoutAt is an SSO logout instruction, not a cross-app online roster.
No account-presence feed has been invented or deployed. A true logged-in list
still needs a scoped, current session/presence source; paid APIs remain disabled.

## Read-only live coverage

Checked at 2026-10-16 04:13 UTC (Oct 15 local), company-scoped production reads.
No active dispatches, pending jobs or open shifts at that snapshot. This is an
off-shift sample, not evidence of daytime GPS coverage or receiver failure.
Eight active canonical profiles; seven shift-authority records. No-shift authority
and missing authority remain distinct. No live working-driver ETA can be proven
from this snapshot; the daytime freshness check remains a field acceptance item.

Fourteen-day history: 98 invoices, 84 with timelines, 424 timeline events,
76 invoices with coordinates, 14 grouped invoices. All 98 have canonical driver
identity. Sample was not capped. The new cleaner extracts 99 usable samples:
35 loading, 17 unloading and 47 driving; 38 drive samples have both coordinates.
Clean loading/unloading evidence currently represents one driver. Company-level
fallbacks must therefore be identified, not called personalized timing for others.
Private raw evidence and scripts remain outside the repository in ignored tmp.

Browser probe: Maps JavaScript API is not activated for the existing key. Separate
Distance Matrix REST probe returns REQUEST_DENIED / legacy API not enabled. Do
not switch on the old unused helper or assume browser road times work.

## Implemented source (not deployed)

- Pure driverArrivalRecommendations engine: finish current physical work, release
  at actual current drop-off, then travel to selected pickup. No fixed 20/15/25
  minute defaults. Exact site/driver/company timing samples disclose their count.
- History filters tenant, canonical driver, closed production-water jobs, recent
  valid adjacent events, pauses and duplicate grouped unloads. Three clean samples
  required for a service-time or matching historical road-leg estimate.
- GPS freshness, stage age, pauses, split stops, multi-load cycles, service-work
  finish time, inconsistent active groups, changed SWDs and orphan open invoices
  produce explicit unknowns rather than fabricated availability.
- Confirmed shared multi-haul drive/unload counted once. Current-work arrival
  excludes pending queue by explicit disclosure; queue counts remain visible.
- Collapsible advisory panel added beside existing PW and SW driver controls.
  Rows explain estimates/unknowns and select using existing setter callbacks.
  Open invoice and linked multi-haul readers are company-scoped. Read failure
  withholds estimates. Target/company keys reset component state.
- HOS/equipment suitability remains unverified, not inferred from shift dots.

Validation: 10 estimator/history regressions pass; TypeScript passes before the
last rendering-only change. Includes farther-free vs nearby-busy, fresh/stale GPS,
release-point travel, grouped unload once, unknown itinerary/pause, changed SWD,
overrun, pending queue, orphan invoice and canonical/tenant identity handling.

## Required before release

1. Finish browser/component interaction tests: everyone selectable, rank updates
   do not change selection, late response cannot replace another target/company,
   async invoice readers fail honestly, narrow layout remains usable.
2. Settle road API cost/approval. For a new road provider use current Routes API,
   not legacy Distance Matrix. Verify browser route access and permissions first.
   Any paid requests should be initial explicit comparison/manual refresh only;
   the existing minute timer must not become a paid polling loop. Deduplicate
   shared legs within one comparison. Verify provider policy before any caching.
3. Run full lib baseline and certified Hosting preflight, inspect scoped diff,
   commit/push, deploy Hosting only and verify live artifact byte matches.

No API enabled, Hosting deployed, app built/installed, dispatch or invoice record
changed for this checkpoint. Existing live source remains 2231baed.

## Cost discussion evidence

Google global Routes Compute Route Matrix Essentials pricing: 10,000 free
elements/month, then USD 5/1,000 through 100,000 total elements, USD 4/1,000 at
100,001–500,000. Matrix billing is per origin/destination pair. Traffic-aware
features use Pro rather than Essentials. Free allowance availability/shared billing
usage has not been audited.

Illustrative only: eight drivers, average two route legs each, 22 workdays.
20 comparisons/day = 7,040 elements/month, USD 0 with unused allowance;
50/day = 17,600, USD 38; 100/day = 35,200, USD 126. Every minute for ten hours/day
= 211,200 elements/month, USD 894.80 at published tiers before taxes/other usage.
No account-specific billing cost or free remaining allowance is claimed.

Primary references:
- https://developers.google.com/maps/billing-and-pricing/pricing
- https://developers.google.com/maps/documentation/javascript/usage-and-billing
- https://developers.google.com/maps/documentation/javascript/routes/get-a-route-matrix
