# Water Orders full-crew workflow

The large-roster picker is retained. The rest of the tab now supports reviewing
and sending orders with 35 or more selected drivers without exposing one large
unfiltered schedule.

- New orders start with no tanks. Dispatch chooses Frac or Upright tanks and
  edits capacities, buffers and current water. Tank editing scrolls internally;
  the existing 120-tank planning limit is also enforced when adding tanks.
- Destination search reuses the catalog and shared keyboard-accessible builder
  autocomplete. A selected catalog location supplies its coordinates. Typed
  destinations without coordinates use the explicit fallback turnaround.
  Coordinates remain an optional override. Concurrent search keystrokes share
  the same catalog load; old search results cannot replace a newer query.
- Source search preserves exclusions and overrides outside the current search.
  Individual selected trucks can override default capacity and hours, with
  searchable, bounded editing. Hours remain advisory order inputs, not HOS.
- Review summarizes quantities and drivers with/without planned loads. Driver
  workload and source forecasts expand independently. The load schedule has
  driver/source search, driver/status filters and 25-row pages. Tables scroll
  inside their containers at narrow widths.
- Preview, ready count and release use the same earlier-load gate. Declined,
  dismissed and cancelled jobs are distinct from delivered volume. The 300-load
  limit is explained when a shortfall remains. Ready means the scheduled start
  is due; live water supply is still checked before creating each dispatch.
- Sequential dispatch displays progress and confirmed counts. Acknowledged IDs
  enter local saved state only after their project transaction completes.
  Partial failures retain confirmed work and explain stable-identity retry.
  Current permission is rechecked across awaits. Oversized order documents
  receive an explicit split-order error before attempting the project write.

No unattended dispatch scheduler, automatic assignment, backend permission,
security rules, HOS or stock reservation policy was changed. Later loads still
require reopening the order and pressing Dispatch. Catalog lookup is driven by
destination entry, with caching; no new polling or paid route calls were added.

Validation uses synthetic data only:

- Planner cases: 35 mixed-capacity trucks, 50 sources, exact tank allocations,
  unique IDs, no truck overlap and daily hour limits; 42 trucks / 120 tanks;
  first-load gates, declined loads, expiry and explicit 300-load shortfall.
- Real React components and planner in Chromium with an in-memory Firestore
  adapter: 35-driver plan, 50 sources, excluded-source retention, catalog
  coordinates, empty initial tanks, individual capacity, 25-row pages and
  filters at 320/344/768/1280px. Changed supply blocks release; a lost response
  after simulated server acceptance retries the same ID without duplicate jobs;
  repeated dispatch waits for earlier loads; reopening and permission revocation
  preserve the gates. No external network requests or customer writes occur.
- The browser regression is mandatory in Hosting preflight alongside the prior
  picker, Watchdog, navigation and release-lineage checks.

The interrupted implementation was preserved in WIP checkpoint 0c632765 while
an urgent monitoring configuration request was handled. This document describes
the completed implementation; deployment proof is recorded after verification.
