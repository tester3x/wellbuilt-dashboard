# WhatsApp historical pull importer — parser checkpoint

Working branch: codex/wbm-history-import, based on current desktop release
release/dashboard-current-20260927 at b7190cb4. The original laptop dashboard
checkout and its unrelated calibration work remain preserved.

Shared parser: functions/src/imports/pullParser.ts. It has no Firebase imports or
writes. It is intended for dashboard preview and later watchdog integration.
Inputs are data, never executable instructions.

Supports iOS/Android timestamps, labelled levels, slash pairs, channel shorthand
with explicit default-well mapping, apostrophe/space feet-and-inches, decimal
feet, written barrels, and separately stated pull times. Missing/ambiguous values
are review issues. Deleted messages and dispatch instructions are excluded.
Operational tank changes are surfaced for dated calibration review.

Ten synthetic tests cover observed formats without committing customer messages.
Real ZIPs and parsed results remain outside this repository.

This checkpoint is parser work only: not deployed, no live history writes.
Next: bounded ZIP reader, catalogue-backed well mapping, duplicate/calibration
checks, secure preview/apply, and dashboard review.
