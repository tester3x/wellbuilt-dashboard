# Safety / Spill Incidents — later activation (not this pass)

Source-only. Do **not** deploy from this commit.

## Firestore

Path (authoritative, WB-T `cde5645`):

`companies/{companyId}/spill_incidents/{incidentId}`
`companies/{companyId}/spill_incidents/{incidentId}/deliveries/{deliveryId}`
`companies/{companyId}.spillReporting.notifyPolicy`

Rules (when a rules deploy is separately authorized):

- Read: platform admin OR same-company staff with `viewSafety` (staff/{uid} companyId match).
- Write incidents: **never** from Dashboard clients. Only Admin SDK / callables.
- Policy write: `manageSafety` or `manageCompany`, same-company, platform admin unrestricted.
- Drivers: no Dashboard access; no cross-company reads.

Index (only if listing uses `where` + `orderBy` later):

- Collection: `spill_incidents` (subcollection)
- Fields: `status` ASC, `acceptedAt` DESC
- Query scope: collection group **not** required if Dashboard always queries one company path.

## Functions (WB-T / Dashboard)

Deploy only when authorized:

- `acceptSpillIncident` (already in WB-T source; not live)
- `authorizeSpillVideoUpload`
- Notification fan-out worker (does not exist)
- Governed action callables (documented in `src/lib/spill/spillActions.ts`):
  - `acknowledgeSpillIncident`
  - `assignSpillIncidentOwner`
  - `addSpillIncidentFollowUp`
  - `resolveSpillIncident`
  - `closeSpillIncident`
  - `reopenSpillIncident`

Each action callable must append audit `{ actorUid, atIso, reason, priorStatus, resultingStatus }` and tenant-match `companyId`.

## Storage

- Governed `spill-videos/**` rules + upload path from `authorizeSpillVideoUpload`.
- Dashboard must keep using storagePath; never public token URLs.

## Providers / secrets

- SMS + email provider
- Secret Manager / `defineSecret`
- Flip `SPILL_ACTION_CALLABLES_AVAILABLE` and store `NOTIFY_*` / `MEDIA_INFRA_READY` flags only after the matching infra is live.

## Staff role enum

Source adds employee responsibilities `safety` and `lead`. Existing Firestore `staff.role` allow-lists must be extended in a **separate** rules deploy before those logins can read staff-gated docs.
