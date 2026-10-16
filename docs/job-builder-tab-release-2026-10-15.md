# Job Builder tab label release

Source 7e8b1422 on release/dashboard-compact-identity-20261015 changes the Dispatch workspace tab label from Build Job to Job Builder. Order remains Jobs, Job Builder, Well Queue. Product change is one string; prior Dashboard repairs remain included.

Hosting deployed to wellbuilt-sync on October 15, 2026 (America/Chicago). Certified preflight passed with fresh build, header/navigation, photo-review, authenticated responsive route rendering, autocomplete scroll and forgot-password guards. Broader library run: 410 passed, 4 pre-existing failures (stale callable inventory demoWellPullPlan and three extensionless-module Node CLI imports), 1 skipped. No backend or rules deployment. Live Dispatch HTML and all 17 referenced JavaScript bundles byte-match the freshly built output; Job Builder label is present in the live bundles.
