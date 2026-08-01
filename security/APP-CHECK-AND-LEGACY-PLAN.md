# App Check integration & legacy hash removal plan

## App Check (clients on security branches)

| App | Status | Notes |
|-----|--------|-------|
| WB-T | Scaffold `utils/appCheckInit.ts` | Native Play Integrity / DeviceCheck at build time |
| Suite | Scaffold `appCheckInit.ts` | Same |
| WB-M / JSA / eWallet | Scaffold next build pass | Mirror Suite pattern |
| Dashboard web | reCAPTCHA v3 / Enterprise | Wire before hosting deploy |

**Debug tokens:** env only (`EXPO_PUBLIC_WB_APPCHECK_DEBUG_TOKEN`) — never commit.

**Enforcement order (future):**

1. Ship clients with App Check init (enforcement off)
2. Monitor metrics for token attach rate
3. Set `SECURITY_ENFORCE_APPCHECK=true` on callables
4. Then default-deny rules

## Pre-login reference classification

| Data | Class | Mechanism |
|------|-------|-----------|
| App registry display names/schemes | Public narrow | `getPublicClientMeta` |
| Company tier/features | Auth company-scoped | `getDriverReferenceBundle` |
| Wells/operators catalogs | Auth global | FS rules read if signedIn |
| Drivers list | Admin only | never public |
| Invoices/tickets | Auth ownership | CF + rules |

## Legacy hash removal

1. Dual-run: `requireSecureDriver` allows `driverHash` until `REQUIRE_DRIVER_CLAIMS=true`
2. After all clients use custom/id tokens: set `REQUIRE_DRIVER_CLAIMS=true`
3. Archive `drivers/approved` to cold storage; stop client R/W (rules deny)
4. Do not derive new scrypt credentials from SHA-256
5. Enforced clients never fall back to anonymous RTDB writes

## Residual callables (Stage B code, deploy later)

- `upsertDriverInvoice`
- `upsertDriverDispatch`
- `sendChatMessage`
- `getPublicClientMeta`
