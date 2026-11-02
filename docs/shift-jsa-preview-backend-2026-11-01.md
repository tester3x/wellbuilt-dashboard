# Saved shift JSA preview — scoped backend deployment

Source: `c476fdfa01224a0ded0bbe3c3922a7fed58dbacc`, pushed on `release/dashboard-owner-signup-20261029`.
Project: `wellbuilt-sync`; codebase: `dashboard`; region: `us-central1`.

Only these Functions were deployed:

| Function | Result | Update time UTC | Source generation |
| --- | --- | --- | --- |
| `jsaGetShiftPreview` | ACTIVE, created | 2026-11-02T02:47:15.574409556Z | 1793587573039391 |
| `jsaGetSavedJob` | ACTIVE, updated | 2026-11-02T02:47:15.800812795Z | 1793587622985989 |

Downloaded deployed source archives byte-match the locally compiled files:

| File | SHA256 |
| --- | --- |
| `lib/jsaReceipt/jsaShiftPreview.js` | `da7acce9526ab1f45624c611af06e1138855496f3ad0a833551b6d9095d50ba6` |
| `lib/jsaReceipt/jsaShiftPreviewCallable.js` | `c37390659432d2199ff1bfe32e16334d4d1a4e051cee998234e653b4f0044ab7` |
| `lib/jsaReceipt/jsaHomeState.js` | `ef5d8663fdbfc7f0bc3d85357f5859656523f6fdf06d90313f006e0e1657fe0b` |
| `lib/jsaReceipt/jsaSavedJob.js` | `b73e509920916ada24406e7d9df7719dee21c5b82ed7379653b39b6fe33037ee` |
| `lib/jsaReceipt/jsaSavedJobCallable.js` | `9aa2c87cc666a26ae905e4f13dd20a8164d562f2e6f89d901fe123ac44399ab6` |

Unauthenticated live requests are refused: the new endpoint returns 403 PERMISSION_DENIED; the historical endpoint retains 401 UNAUTHENTICATED. Successful authenticated handset invocation of the new endpoint is pending the client build; do not describe the admin-assisted live-data projection as a handset API test.

Functions TypeScript and all 114 JSA-related tests across 11 suites passed. The new tests verify canonical WB JSA projection equality, original signed job with an empty locations array, later stops, off-shift newest signed document/standalone additions, new-shift isolation, unavailable shift/artifact errors, ownership boundaries, caller input and bounded history. A read-only admin-assisted projection of the actual off-shift record included all five locations, including the previously missing first job. No production JSA/signature/acknowledgement, shift or job records were edited.

The existing installed client's historical preview benefits from the original-job fix on reopening. The redesigned View Shift JSA client is pushed separately in WB T (`0410fbed`, final owner fence `eb0a7aff`, handoff `51734395`) and is not yet built/installed. Test a reconciled local APK on S24 before ZFold at home. Active-shift and off-shift visual checks remain pending. WB JSA lifecycle/coverage semantics are unchanged; off-shift viewing never authorizes a new shift.

Dashboard Hosting and security rules were not deployed. Private source archives, deployment logs and live-data proof remain outside Git under `C:/dev/tmp/shift-jsa-*` and `C:/dev/tmp/wbt-shift-jsa-live-proof-private.json`.
