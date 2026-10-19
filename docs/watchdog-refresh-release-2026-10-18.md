# Watchdog Refresh release — 2026-10-18

Hosting source:fb0f7b74 on release/dashboard-watchdog-20261018. This is the Refresh-only patch cherry-picked from dc655405 onto the previously deployed9631f662 baseline; pending JSA settings changes are excluded.

The refresh control now provides visible loading feedback, pointer/focus styling, a 15-second callable deadline, retryable failure messages, last-checked feedback, and duplicate-request suppression. Responses from an unmounted or changed company scope cannot populate the current inbox. Server review authorization and decision handling are unchanged.

Browser behavior verified against the actual component using synthetic data and no live Firebase calls: click, busy state, repeated-click suppression, error/retry, successful timestamp, and company-switch isolation. All certified Hosting preflight gates passed (fresh production web build, navigation/capabilities, photo contract, responsive route render, Job Builder scrolling/autocomplete and password recovery). Library suite: 459 passed, 1 skipped. Live verification: 348/348 artifacts byte-match, zero mismatches.

Deployed: https://wellbuilt-sync.web.app/watchdog/. No APK built or installed. Private deployment logs and byte proof remain outside Git under C:/dev/tmp/watchdog-refresh-*.
