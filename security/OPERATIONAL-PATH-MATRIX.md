# Operational Path Matrix (default-deny blockers)

**Project:** wellbuilt-sync  
**Status:** dual-run design; production rules still open  
**Secured callables (implemented, not deployed this pass):**  
`ingestDriverPacket`, `upsertDriverShift`, `submitJsaRecord`, `updateDriverProfile`, `signalDriverLogout`, `getDriverReferenceBundle`, `requestStorageUploadPath`

## Critical paths that block default-deny

| Domain | Path | Apps | Today | Proposed | Status |
|--------|------|------|-------|----------|--------|
| Packets | RTDB `packets/incoming/{id}` | WB-T, WB-M | Direct PUT | `ingestDriverPacket` + CF trigger | **Adapter dual-run** |
| Packets | `packets/processed`, `outgoing` | WB-M, Dashboard | Direct read | Auth read rules / scoped | **Rules draft** |
| Invoices | FS `invoices/{id}` | WB-T, Suite, Dashboard | Client R/W open | Existing ticket CFs + deny client write | **Rules draft; CF already partial** |
| Tickets | FS `tickets/{id}` | WB-T | CF submitTicket + client | CF-only | **Rules draft** |
| Dispatch | FS `dispatches/{id}` | WB-T, Suite | Client R/W | Auth read + CF write | **Rules draft** |
| JSA | FS `jsas`, `jsa_day_status` | JSA, WB-T, Suite | Client R/W | `submitJsaRecord` | **Callable + dual-run API** |
| Shifts | FS `driver_shifts` | Suite | Client R/W | `upsertDriverShift` | **Callable + dual-run API** |
| Photos | Storage `photos/{company}/{invoice}/…` | WB-T | Open upload | Auth Storage rules + `requestStorageUploadPath` | **Rules + path helper** |
| JSA PDF | Storage `jsa/{company}/…` | JSA | Open upload | Auth Storage rules | **Rules draft** |
| eWallet | Storage `ewallet/{driverId}/…` | eWallet | Mixed | Claim-scoped path | **Rules draft** |
| Drivers | RTDB `drivers/approved`, `pending` | All mobile | World R/W | Identity callables (live) + no client write | **Identity live; writes denied in draft** |
| Profile | RTDB `drivers/.../profile` | Suite, WB-T | Direct PATCH | `updateDriverProfile` | **Callable** |
| Wells | RTDB `well_config`, FS wells | WB-M, WB-T | Open read | Auth read | **Rules draft** |
| Chat | FS `chat_threads` | WB-T | Open R/W | CF/auth (next) | **Rules deny write; CF needed** |
| Admin | FS companies, billing, payroll | Dashboard | Open write | Auth dashboard + CF | **Rules draft** |
| Registry | FS `app_registry` | All switchers | Open read | Auth read OK | **Rules draft** |

## Mechanism selection guide

| Workload | Mechanism |
|----------|-----------|
| Small JSON business events (packets, shifts, JSA meta) | Callable + Admin SDK |
| Large photos/PDFs | Direct Storage upload with Auth + path scoped by claims; optional path-mint callable |
| Reference catalogs | Authenticated client read under rules |
| Privileged admin mutations | Dashboard Auth + manage* capability; prefer CF for deletes/approvals |
| Packet processing pipeline | Keep `processIncomingPull` RTDB trigger (Admin); only **ingest** becomes authenticated |

## Offline / S.A.F.E.

| Queue | Location | Migration |
|-------|----------|-----------|
| WB-T safeOutbox | AsyncStorage | On replay after secure build: obtain/refresh ID token → `ingestDriverPacket` / ticket CFs / Storage with Auth. On permission-denied: retain item, surface error, do not anonymous fallback. |
| WB-M packet queue | Local | Same: secure ingest with `idempotencyKey=packetId`. |
| Chat pending messages | AsyncStorage | Replay with Auth; path mint for photos. |
| Pre-security queue items | Local only | Drain while dual-run rules open; after cutover, only secure endpoints accepted. Never drop on token expiry—reauth then retry. |

## Identity mapping

| Field | Secure plane |
|-------|----------------|
| `auth.token.kind == 'driver'` | Required for driver callables |
| `auth.token.driverId` | UUID profile id (not public SHA) |
| `auth.token.companyId` | Tenant scope |
| Transitional `driverHash` | Allowed until `REQUIRE_DRIVER_CLAIMS=true` |

## Dashboard admin writes

| Operation | Secure path |
|-----------|-------------|
| Approve/reject drivers | Live admin callables |
| Invite employee | Existing `inviteEmployee` |
| Invoice/billing/payroll | Future Auth-bound rules + existing client during dual-run; post-enforce CF for sensitive counters |
| Equipment | Existing eQuipment* callables |

## Explicit not fully callable-wrapped this pass

- Full chat create/message path (rules deny client write; needs `sendChatMessage` CF next)
- Full invoice setDoc client path (existing submitTicket/updateTicket preferred; rules deny direct write)
- Route recordings GPS streams (high volume — design streaming CF or Auth-bound rules with company claim)
- Transfer request client writes (partial CF already)

These remain **documented residual gaps** before declaring default-deny safe.
