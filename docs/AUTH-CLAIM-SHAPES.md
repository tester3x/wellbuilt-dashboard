# Observed Firebase Auth claim shapes (2026-08-16c)

This is the live source-of-truth used by the closed rules. Do **not** invent extra claims.

## Driver tokens (WB-M / WB-T / JSA / eQuipment)

Minted by `mintDriverSessionTokens` / SSO developer claims:

- `kind === "driver"`
- `driverId` (canonical UUID)
- `companyId`
- `roles` (string array; manual login always; SSO WBM token only)
- optional session `app` (`wbm`, `wbt`, …) — per-token, never written via `setCustomUserClaims`

SSO tokens for Suite→WB-T, WB-T→JSA, and Suite/eQuipment keep their established claim set (`kind`, `driverId`, `companyId`, `app`). WBM SSO additionally carries `roles` / `isAdmin` / `isViewer` on that token only.

## Dashboard platform admin

Confirmed by `functions/src/admin/authority.ts`:

- custom claim `wellbuiltAdmin === true`
- **and** enabled Firestore `platform_admins/{uid}`

Company-level Dashboard staff are **not** proven to carry `token.role`. Staff authorization that must work today is `users/{uid}/role` in RTDB (`admin` | `it` | `manager` | `dispatch`). Firestore rules cannot read RTDB, so they must **not** use `token.role`.

## Firestore staff authority (source-only model)

Closed Firestore rules use a server-written staff document, not a token role:

- `platform_admins/{uid}.enabled == true` **and** `token.wellbuiltAdmin == true` for platform admin
- `staff/{uid}` with `{ enabled: true, role: 'admin'|'it'|'manager'|'dispatch', companyId }` for company staff
- a removed platform admin (claim present, `platform_admins/{uid}.enabled != true`) is denied
- a disabled or missing `staff/{uid}` is denied
- staff without a matching `companyId` are denied company-scoped reads
- ordinary signed-in users (`kind == 'driver'` or no staff record) cannot use staff paths

`staff/{uid}` and `platform_admins/{uid}` are CF-only writes.

## Owner / company / staff policy (must match rules, callables, matrix)

| Collection | Driver read | Staff read | Client write |
|---|---|---|---|
| invoices / tickets / dispatches | owner + same company | staff same company | **none** (callable only) |
| jsas / jsa_day_status | owner + same company | dashboard | owner create/update only |
| chat_threads / messages | thread participant + company | staff same company | **none** (callable only) |
| customLocations | same company | dashboard | **none** |
| unmatched* | none | none | **none** |
| reference catalogs with `companyId` | same company | staff same company | **none** |

Do **not** deploy these rules while required WB-T writers remain incomplete replacements.

## Temporary compatibility exception

`jsa_read_receipts` unauthenticated create + exact GET remains a documented temporary compatibility exception, not the final secure architecture.
