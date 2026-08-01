# Phase 3 — Compatibility Migration Matrix

## Force credential reset policy

All pre-existing `drivers/approved/{sha256}` identities are **exposed**.
**Every legitimate driver must receive a new passcode** (admin-set or re-register).
Legacy SHA-256 is **not** accepted by `authenticateDriver` after cutover.

## App matrix

| App | Repo | Direct DB today | Required source changes | New build required? | Old build after enforcement | Re-login? | Re-register / reset passcode? | Offline after migration |
|-----|------|-----------------|-------------------------|---------------------|----------------------------|-----------|-------------------------------|-------------------------|
| Dashboard Admin | `Dashboard` | Auth SDK open rules | Approve/reject/list via callables; rules for Auth users | Deploy hosting | Admin web must be redeployed | Yes (Auth unchanged) | No (email Auth) | N/A |
| WellBuilt Suite | `Suite` | REST RTDB/FS | `driverAuth` → callables + custom token; remove direct pending/approved writes | **Yes** | **Stops working** for login/register | Yes | **Yes — new passcode** | Local session until expiry; re-auth on server |
| WB-T | `WB-T` | REST + FS heavy | Same auth; later data rules need Auth SDK writes | **Yes** | **Breaks** login + many FS writes | Yes | **Yes** | Outbox needs Auth token refresh |
| WB-T-Metro | `WB-T-Metro` | Parity WB-T | Same as WB-T | **Yes** | Breaks | Yes | **Yes** | Same |
| WB-M | `WB-M` | RTDB packets | Auth + packet ingest path | **Yes** | Breaks | Yes | **Yes** | Packet queue after auth |
| WB-M-delivery | `WB-M-delivery` | Parity WB-M | Same | **Yes** | Breaks | Yes | **Yes** | Same |
| JSA | `JSA` | RTDB + self-approve | Remove self-approve; callables | **Yes** | Breaks; self-approve blocked at rules | Yes | **Yes** (standalone server path) | Local drafts then sync |
| eWallet | `eWallet` | Auth RTDB + CF | driverAuth callables; keep eQuipment CF | **Yes** | Auth breaks | Yes | **Yes** | Local-first docs OK |
| wellbuilt-ewallet | `wellbuilt-ewallet` | Legacy direct docs | Prefer eWallet path; auth callables | **Yes** | Breaks | Yes | **Yes** | Local |

## Legitimate users expected to reset

| Person / device (from approved list) | Company | Action |
|--------------------------------------|---------|--------|
| MikeS24, Mikezfold, TabletS10, iPhone16 | Liquid Gold | New passcode via Admin `adminSetDriverPasscode` or re-register |
| Marcial Lebaron, AdanS, Wisho-135 | Liquid Gold | Same (WB-M testers) |
| AcmeMike | Acme EOG Test | Same |
| Test Auth | Liquid Gold | Same or deactivate |
| ABurger | Acme (inactive) | Leave inactive; no login |

Mike’s daughter: if she uses one of the above device names, same reset; confirm which displayName.

## Staged plan

1. **Deploy functions only** (dual-run): new callables live; open rules **unchanged**.
2. Ship updated apps to Mike + testers.
3. Admin migrates profiles + sets new passcodes (or users re-register → approve).
4. Verify login/register/approve/offline on new builds.
5. Mark legacy hashes unusable (`active: false` or delete login path).
6. **Enforce secure rules** (Mike authorization required).
7. Probe anonymous deny; probe cross-tenant deny.
8. Monitor function logs.

## Apps Mike must install before rule enforcement

1. Suite (latest security build)
2. WB-T (or Metro if that’s the production ticket app)
3. WB-M (if still used for pulls)
4. JSA
5. eWallet / equipment app in use
6. Dashboard hosting deploy for admin approve UI

**Do not enforce rules while any production device still runs pre-security APKs.**
