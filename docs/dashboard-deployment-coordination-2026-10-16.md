# Dashboard deployment coordination — 2026-10-16

User reports desktop demo work deployed an older Dashboard and is restoring the graphical changes. Laptop will make no further Hosting deployments while that reconciliation is underway. This note is a handoff, not evidence of desktop source or current live state.

Preserved laptop branch: release/dashboard-compact-identity-20261015
Last verified runtime source: d02416c8508f2d107191fb3c7fbcceb48730828c
Release documentation checkpoint: 052dac49
Repository: tester3x/wellbuilt-dashboard

Before the next combined deployment, fetch and compare this branch with the desktop demo branch. Preserve both histories and integrate the intended demo changes with the existing approved Dashboard layout/search/dispatch repairs and driver arrival recommendations; do not release an older full checkout over either lane. Verify the combined source, run the certified Hosting preflight, and byte-verify the resulting live artifacts. Only one lane should deploy the shared Hosting site during reconciliation.

Driver arrival source is committed and pushed, including history-first estimation, on-demand Google fallback, no geographic cutoff or shift gate, and all drivers selectable. The dedicated Google Routes key is supplied via ignored NEXT_PUBLIC_DRIVER_ROUTES_API_KEY, not Git. A desktop build without that environment variable will have no Google fallback. Provision the existing restricted key privately; do not copy it into source or reports. API restrictions allow only the two wellbuilt-sync Hosting origins and Routes API. Do not re-enable paid automatic polling when integrating.

Full verification and limitations: docs/driver-arrival-first-version-wip-2026-10-15.md. No desktop report folder is accessible at C:/dev/reports or D:/dev/reports in this laptop session. This Git-backed handoff is available to desktop after fetch. No direct message was sent to another chat.
