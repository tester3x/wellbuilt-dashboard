# Watchdog manual refresh - 2026-10-19

User selected manual refresh for Needs Review instead of scheduled polling or a new event transport. Removed the 15-second list timer. Opening the inbox, changing company, pressing Refresh, or saving a review decision still fetches the current list. No background periodic list calls remain in this component.

Hosting source 2dced639 committed, pushed, built and deployed to wellbuilt-sync. Certified preflight passed, including navigation, photo review, responsive authenticated routes, Job Builder scroll and password recovery. Browser regression passed, including two minutes without an idle fetch, manual retry, duplicate-click suppression and stale company response protection. Library suite: 459 passed, one skipped. Live artifacts: 353/353 exact byte matches, zero mismatches. Desktop demo and completed-date changes retained. No backend or rules changes, and no mobile builds.
