# Shared multi-haul card release

Source 4c8c0bc0, branch release/dashboard-compact-identity-20261015. Hosting deployed 2026-10-15; mandatory certified preflight passed. Live dispatch HTML and all 17 linked JS bundles match the build byte for byte. No Functions, rules, or job-record changes.

Invoice-owned multi-haul membership is subscribed at the Active Jobs panel so it drives both grouping and child badges. Matching live group, tenant, and driver produces one expandable Multi-Haul card with a job count; each child retains its own well, dates, stage, and controls. Ordinary pending stacks retain their existing load labels. Clearing membership restores independent cards. Active Jobs counts still count jobs, not trips.

All 16 targeted grouping and presentation tests pass, including different wells sharing a trip, isolation across trips/tenants/drivers, and clearing membership. Existing header, Photo Review, responsive authenticated routes, autocomplete scroll, and forgot-password checks passed in Hosting preflight. Prior unrelated broad-lib test limitations remain as recorded in dispatch-cards-release-2026-10-15.md.
