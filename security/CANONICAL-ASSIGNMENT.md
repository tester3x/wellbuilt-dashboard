# Canonical driver assignment contract

Authority is **only** the canonical profile:

```
drivers/profiles/{driverId}.assignedRoutes   // string[] when written
drivers/profiles/{driverId}.assignedWells    // string[] when written
```

Dashboard `drivers/approved/{legacyHash}` is a dual-run mirror while the
legacy Drivers UI remains. It is not eligibility authority for WB-M.

## Company-driver semantics

| Profile fields | Status | Well config | WB-M gate |
|---|---|---|---|
| Real route name in `assignedRoutes` | eligible | those routes (plus any `assignedWells`) | `/welcome` or tabs |
| Nonempty `assignedWells` only | eligible | those wells | `/welcome` or tabs |
| Explicit `[]` / Unrouted-only / no wells | ineligible | no wells | `/no-access` |
| Both fields missing | unknown (`assignment_unavailable`) | no wells | `/session-verify` |
| Network / auth / permission failure | unknown | n/a | `/session-verify` |
| Revoked session | — | — | `/driver-login` |

Missing fields **must not** grant all company wells.
Explicit empty arrays **must not** grant all company wells.

No-company admin unrestricted access is a **separate explicit policy**.
`getDriverWellConfig` still requires `companyId` (`company_required`).

## Writes

- `adminAssignDriverAssignment` (manageDrivers, staff company or platform).
- Payload: `{ driverId?, legacyKey?, assignedRoutes: string[], assignedWells?: string[] }`.
- `assignedRoutes` is always an array. Saving zero checkboxes writes `[]`
  (ineligible), never `null`.
- Dual-write uses one RTDB multi-path `update`. Canonical + legacy succeed
  together or the callable refuses. Partial writes cannot silently succeed.
- Clients must not `update(drivers/approved/.../assignedRoutes)` directly.

## Reads

- `bootstrapDriverSession` returns `assignedRoutes` / `assignedWells` as
  `string[] | null` (`null` = field missing).
- `getDriverWellConfig` returns `{ wells, assignmentStatus, assignmentReason }`.
  Status is `scoped | ineligible | assignment_unavailable | no_company`.
  It never defaults a company driver to the full company catalog.

## Migration

`scripts/canonical-assignment-migrate.mjs --dry-run --names Mikezfold,MikeS24`

- Maps each requested display identity to **exactly one** active canonical
  `driverId` and **exactly one** active legacy approved row.
- Requires matching `companyId` and normalized display name.
- Refuses duplicates, inactive rows, company mismatch, and missing legacy
  assignment arrays.
- Default is dry-run. Apply is a separately authorized step.

## WB-M vc8

Installed vc8 reads `drivers/profiles/{driverId}.assignedRoutes` over REST.
After a controlled **apply** of this migration for Mike, Try Again should
become eligible **without a new APK**. Remaining client source (reason on
`/session-verify`, wells-only eligibility, `getDriverWellConfig` status)
ships in a later vc9 only if field results require it.
