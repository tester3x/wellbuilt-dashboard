# Driver arrival recommendations: read-only source audit

Date: October 15, 2026 (America/Chicago).
Dashboard baseline: ce5fe8c5, release/dashboard-compact-identity-20261015.
WB Tickets inspected: f899ffc, codex/wbt-enroute-20261014.

## User requirement

For a selected job, recommend drivers in estimated pickup-arrival order, including
time needed to finish their current work and travel from their eventual release
location. Recommendations are advisory. Preserve the existing company-scoped
selectable driver roster and assignment permissions: ranking, missing data,
confidence, shift state and modeled suitability introduce no new selection locks.
Dispatch may know facts the model does not. No automatic assignment or queue edits.

## Inputs found

| Input | Existing source | Readiness for recommendations |
| --- | --- | --- |
| Canonical driver/company identity and legacy aliases | src/lib/dispatchRosterProjection.ts, dispatchDriverIdentity.ts | Existing roster and identity joins; reuse instead of joining names. |
| Active/pending/accepted/paused jobs, job type, destination, planned/completed load counts | src/app/dispatch/page.tsx DispatchJob and Firestore dispatch listener | Already available on Dispatch. Multiple rows do not necessarily mean multiple physical trips. |
| Current stage and stage timestamp | driverStage, driverDest, stageUpdatedAt; WB-T utils/dispatchService.ts updateDriverStage | Pickup travel, at pickup, drop-off travel, at drop-off, pause and completion. Queued writes can arrive late; timestamps are evidence age, not proof of uninterrupted activity. |
| Driver coordinates and capture time | driverLat, driverLng, driverGpsAt on dispatch docs | WB-T publishes GPS at stage changes, including a bounded supplementary capture. This is not established continuous tracking. An old departure fix is not the current location; idle drivers can have no active dispatch/GPS. |
| Pickup and disposal coordinates | Company/operator catalog, selected well records; disposalLat/disposalLng and current destination | Can resolve a target and expected release point. Destination changes require using the current destination, not blindly the originally assigned SWD. Missing or ambiguous coordinates stay unknown. |
| Multi-haul and split relationships | splitGroupId/sequence/total on dispatch; invoiceDocId -> invoice haulGroupId used by ActiveDispatchPanel | Existing open-invoice subscriptions validate company + dispatch identity. Count a shared physical drive/unload once; preserve multiple pickups/split stops. Group membership alone does not prove the remaining stop order. |
| Actual past travel and on-site durations | src/lib/driverLogs.ts invoice timeline events; src/lib/invoices.ts actualDriveMinutes, driveDistanceMiles | depart/arrive/depart_site/close with times, locations and legs can support empirical travel/loading/unloading estimates. Current Driver Logs aggregates on-site time, not a trained separate loading/unloading model. Raw timelines need classification and quality filtering. |
| Current open shift | src/lib/resolveCompanyDriverShifts.ts, shiftDotCore.ts; staffResolveCompanyDriverShifts | Canonical company-scoped open/none/unverifiable status already refreshed every minute. It is not HOS remaining, online presence or proof the driver is free. Overnight shifts must follow canonical authority, not today's document alone. |
| Road distance and travel time | src/lib/directions.ts | Existing Google Distance Matrix wrapper returns minutes/miles or null. No current caller outside the unused ETA helper was found. Working browser access, API response coverage and rural routes have not been verified in this audit. |
| Equipment, capacity, qualifications and HOS remaining | Other application/profile domains | Not a complete current feed in the Dispatch driver projection/shift resolver. Do not claim equipment suitability or legal remaining driving time from the shift dot. A governed source and coverage verification are needed before using these signals. |

## Existing ETA helper is not suitable as-is

src/lib/driverEta.ts has no callers in the inspected src tree. It uses fixed
20-minute loading, 15-minute unloading and 25-minute travel defaults, chooses the
first active dispatch, assumes a 15-minute pause, and never checks driverGpsAt.
Its projected ETA adds remaining work to travel from the driver's current point
to the new job, rather than travel from the location where that work will finish.
It has no grouped-trip model, history-derived durations or HOS integration.
Its 'gps' source label means a distance response was obtained, not that the
origin fix is fresh. Do not surface these values as measured availability.

## Recommended arrival model

pickupArrival = estimatedReleaseTime + roadTravel(releaseLocation, selectedPickup)

For a free driver with a sufficiently fresh location, release time is now. For
working drivers, first construct the remaining physical itinerary: remaining
pickup travel/work, additional grouped pickups, drop-off travel/work and any
known split stops. Compute the release location after those stops. On-site
remaining time should use actual stage age plus defensible historical duration
estimates; elapsed time beyond an average does not prove the driver is finished.

Pending DDJD jobs express existing assignments, but are not a guaranteed immutable
execution sequence. Show the queue impact explicitly. A useful first display can
distinguish arrival after current work from arrival after the existing planned
queue, rather than silently skipping commitments or claiming they must all run
first. Pauses, transfers, service work with unknown duration, conflicting active
rows and unknown stop order need an uncertainty reason, not a fixed pretend ETA.

Ranking should use estimated pickup arrival as the main key; additional travel
distance can break similar arrivals. Show location age, remaining-work estimate,
travel estimate, existing commitments and confidence beside the recommendation.
Unrankable drivers remain selectable with a reason. Off-shift and unresolved-shift
drivers remain visible/selectable under current permissions; no fictional start
time is assigned to them. Avoid precise arrival claims from straight-line miles.

History can be grouped by driver, job type, pickup/SWD, load volume and time of
day where enough clean examples exist, with broader fallback samples and their
sample counts disclosed. Stale GPS must not be advanced merely by subtracting
elapsed time from a guessed journey. Scope all joins by company and canonical
driver/invoice identity; exclude demo, cancelled and inconsistent history from
production timing estimates. Do not treat absence from a limited query as idle.

## Next implementation steps

1. Measure authorized live-source coverage: driver GPS freshness, stage age,
   complete active-job linkage, valid destination coordinates and timeline samples.
   This audit inspected source contracts/writers, not production coverage counts.
2. Prove an authorized road-time read for the Dashboard and define honest missing
   route behavior. No new broad client data permissions or credential changes.
3. Build a pure itinerary/arrival estimator with explicit reasons and deterministic
   tests: nearby busy versus farther free, grouped unload counted once, split stops,
   changed SWD, stale/missing GPS, unknown pause, overnight shifts, queue conflicts,
   cross-company identity and out-of-order updates.
4. Add an advisory panel to the selected-job driver picker. Retain every existing
   driver option and the ordinary manual assignment action. Selecting another job
   recomputes recommendations and ignores late results for the previous target.
5. Compare predictions with actual arrivals before tightening confidence or adding
   further automated behavior. Automatic assignment is outside this request.

## Work performed

Read-only source audit and this report only. No runtime code, records, services,
phone installations or Hosting deployments changed. No runtime tests were needed
for this documentation-only checkpoint. No customer data or credentials included.
