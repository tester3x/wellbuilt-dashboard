**Mikezfold / MikeS24 eQuipment handoff comparison — September 12, 2026**

User reports that Mikezfold remains blocked getting through the WB eQuipment handoff to DVIR while MikeS24 passes. This is tracked alongside the dashboard Firebase repair audit. The observation does not by itself isolate account data from device/app/session differences.

Read-only live comparison:

| Evidence | Mikezfold | MikeS24 |
| --- | --- | --- |
| Canonical name mapping | Resolves to a driver ID | Resolves to a different driver ID |
| Profile active | true | true |
| Company | liquid-gold | liquid-gold |
| Open canonical period | 2026-08-23_232617 | 2026-09-12_020000 |
| Origin-day shift document | Agrees with open canonical period | Agrees with open canonical period |
| September 12 shift-day document | Absent | Present |
| Authority last updated | August 24 | September 12 |

This is a concrete state difference, not proof of a corrupt identity. Both observed period pointers agree with their respective origin-day records.

The deployed `ssoIssueAuthorizationCode` source was retrieved, rather than relying on the older working checkout. It authorizes eQuipment against `driver_shift_authority` and explicitly states that shift age does not close an open canonical period. A matching August 23 period is therefore not automatically invalid just because it is old. A requested period that differs from the canonical pointer is refused as `shift_id_mismatch`.

The inspected server logs from September 10 through the query time show one successful equipment issuance/exchange sequence on September 12 and no recorded SSO refusal in that interval. Those success logs omit driver identity, so they are not independently attributed to MikeS24. Absence of a logged refusal does not prove that Mikezfold reached the server or that the device is healthy.

The dashboard audit fixes remain justified independently, but no evidence yet ties its direct-write defects to this specific mobile handoff failure. Do not describe repairing Settings or Billing as a demonstrated cure for ZFold. Do not delete/recreate the account, fabricate DVIR completion, or close its shift solely on the basis of its age.

The next diagnostic should be bounded to one failed attempt: capture its originating app/build, authenticated canonical driver ID, requested period, phase, destination URI (with authorization secrets redacted), local error and corresponding server trace. Compare the requested period with the saved authority. If needed, test accounts on the same device/app build to separate an account-state difference from cached device state. A confirmed mismatch should receive a targeted session/period reconciliation through the governed lifecycle, preserving history and real DVIR requirements.

Evidence: [account comparison](C:/dev/output/dashboard-audit-20260912/mike-account-comparison.json), [recent SSO logs](C:/dev/output/dashboard-audit-20260912/recent-handoff-logs.json), [deployed issue handler](C:/dev/output/dashboard-audit-20260912/deployed-sso/src/sso/ssoIssueHandler.ts:105), [deployed equipment policy](C:/dev/output/dashboard-audit-20260912/deployed-sso/src/sso/equipmentAuthorization.ts).

No production application data was modified in this comparison.
