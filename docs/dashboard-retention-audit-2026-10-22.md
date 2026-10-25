# Dashboard retention audit — 2026-10-22

## Result

Hosting source **be7b7d59** was freshly built, passed the canonical deploy preflight,
and deployed to `wellbuilt-sync` on October 22. Live verification at
**2026-10-22T21:38:39.753Z** byte-matched all **362** exported files, including
HTML, JavaScript, CSS, and public media. Functions and database, Firestore, and
Storage rules were not deployed.

The previous manual-refresh repair (source f5a8b803) fixed polling but did not
restore every approved desktop change. Its 111-file HTML/JS/CSS verification
proved that release's bytes, not preservation of the earlier approved feature
set. The earlier statement that demo changes were preserved was too broad.

## Missing changes restored

Compared the full `src` and `public` trees with the approved combined desktop and
Watchdog baseline **b1e45782b049475538c6ffed9fafb2c62d57b69f**, and reviewed the
remaining differences against subsequent approved work.

- Restored the completed Dispatch card's full month/day/year and time, on the
  left of its wrapping second row so the demo phone overlay cannot hide it.
- Restored the approved white demo entry logo, three phone captures, and five
  logo assets. Restored content-hash URL versions for the three captures.
- Restored the Hosting preflight guard against a missing or disabled Watchdog
  route. Kept the manual-refresh repair and its no-idle-polling test.
- Added mandatory release checks for all eight media files, matching capture URL
  hashes, the white entry logo, and the actual production completed-card date
  rendering at 344, 412, 768, and 1280 pixels.

The demo entry, overlay, and public media now match that approved baseline.

## Later fixes retained

Reviewed the remaining source differences rather than reverting the whole tree:

- Scoped tab URL, view/filter, and scroll restoration, including header return
  links and company isolation.
- Dispatch active-job-first split ordering and removal of the redundant
  destination text.
- Office sync alerts and notification-preference migration, preserving explicit
  choices and driver defaults.
- Driver arrival selector behavior and layout, Water Orders, preferred drop-off,
  cancelled/dismissed history, well search, header navigation, and Photo Review.
- The later JSA settings lifecycle changes from 67b4444f are intentional; the
  obsolete settings controls from the older baseline were not restored.

The separate NDIC backend update remains untouched by this frontend release.

## Validation and source continuity

- Library suite: **460 passed, 1 existing skipped, 0 failed**.
- Focused checks passed for Dashboard return state, office-alert preferences,
  the production driver-arrival panel, approved restorations, and manual Watchdog
  refresh. Two simulated idle minutes produced no Watchdog refresh requests.
- Fresh-build preflight passed header/navigation, Photo Review contract, all 26
  authenticated route responsive renders, autocomplete scrolling, forgot-password
  behavior, restored-media/date checks, and manual-refresh checks.
- All 362 live artifacts byte-matched the fresh export.

Restoration commits **354ca944**, **b9be1f20**, **c3bcd9ec**, **b4eabbfa**, and
**be7b7d59** were pushed on `release/dashboard-watchdog-manual-20261022`.
Their equivalents **efc8ee9a**, **97450da0**, **b7f10e16**, **73dc730d**, and
**2a37ca2f** were also pushed to the continuing working branch
`release/dashboard-compact-identity-20261015`, preventing a future release from
starting without these repairs. The continuing checkout's unrelated untracked
`app.json` was preserved.

Private deployment logs and the complete live hash manifest remain outside Git.
This document is an audit of the known approved fixes, not a claim that every
possible Dashboard interaction has been exercised against production data.
