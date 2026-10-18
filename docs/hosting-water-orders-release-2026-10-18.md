# Dashboard Hosting release — 2026-10-18

User explicitly authorized dashboard deployment after the overnight source work.

Deployed source: d27184062fa9172ce24c4d34468897a51d836c0b, release/dashboard-compact-identity-20261015, synced with origin before release. Includes Water Orders / Plan Supply / governed Dispatch and all preceding branch work. Hosting target: wellbuilt-sync, https://wellbuilt-sync.web.app.

Validation: 455 library tests passed, 1 existing skipped. The initial plain Node runner could not resolve three extensionless TypeScript imports; rerunning the complete suite with tsx passed. Firebase Hosting predeploy certified canonical branch, clean working tree and approved UI baseline ancestry; compiled a fresh production build; passed header/navigation, photo review, authenticated responsive routes, project autocomplete scrolling, and password-recovery DOM checks. Firebase reported release complete.

Live verification fetched the homepage, Dispatch page, and referenced/feature JS and CSS (22 files total); every SHA-256 matched the fresh out/ build. Verified at 10/18/2026 08:39:38. Full verification metadata is outside Git at C:/dev/tmp/dashboard-live-verification-20261018.json. No rules, Functions or app builds were deployed. Pre-existing untracked app.json was preserved outside the checkout for the clean-tree gate, restored afterward, and its original SHA-256 B7C55ADF9886178318B9A475422A1A361CB6A3211B82F774104C77E460A1EC88 was confirmed.

Water Orders is under Dispatch → Job Builder → Water Orders. Future trips stay saved in the order for dispatch to release when ready; there is no unattended release scheduler in this version. Authenticated live order creation was not exercised against customer data; governed writer identity/authority regressions and the release DOM checks passed.

