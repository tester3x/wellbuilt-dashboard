# Client build & tester credential matrix

## Apps that must be replaced before rule enforcement

| App | Repo security branch HEAD (at writing) | Build required | Notes |
|-----|----------------------------------------|----------------|-------|
| WB-T | `security/database-containment` (extends vc33 + dual-run) | **Yes** | Do not use `diag/first-photo-lifecycle` for security APK until merge authorized |
| WB-M | security branch | **Yes** | Packet dual-run |
| Suite | security branch | **Yes** | Auth + shifts/profile APIs |
| JSA | security branch | **Yes** | No self-approve; JSA submit API |
| eWallet | security branch | **Yes** | Auth dual-run |
| Dashboard | security branch | Hosting deploy later | Admin secure reject/approve UI |

## Credential migration (not executed this pass)

All legacy SHA-256 hashes remain **exposed**. At migration time:

1. Admin `adminSetDriverPasscode` with **new** temporary passcode (`temporary: true`)
2. Driver secure login → `mustChangePasscode` → `driverChangeOwnPasscode`
3. Do **not** derive from legacy hash
4. Keep legacy `drivers/approved` **active** until cutover (`keepLegacyActive` default)

### Order (Liquid Gold + Acme from approved list)

| Order | displayName | Company | Apps likely | Action at migration |
|------:|-------------|---------|-------------|---------------------|
| 1 | MikeS24 | Liquid Gold | Suite, WB-T, JSA, eWallet | Temp passcode → first change |
| 2 | Mikezfold | Liquid Gold | Suite, WB-T | Same |
| 3 | TabletS10 | Liquid Gold | Suite/tablet | Same |
| 4 | Marcial Lebaron | Liquid Gold | WB-M (+ others if used) | Same |
| 5 | AdanS | Liquid Gold | WB-M | Same |
| 6 | Wisho-135 | Liquid Gold | WB-M | Same |
| 7 | iPhone16 | Liquid Gold | As used | Same |
| 8 | AcmeMike | Acme | Suite/WB-T test | Same |
| 9 | Test Auth | Liquid Gold | Internal | Reset or deactivate |
| 10 | ABurger | Acme inactive | Skip login | Leave inactive |

Not every identity needs every app—migrate credentials once; app installs only for apps they use.

## Deploy order (future authorization)

1. Deploy operational callables (this code)  
2. Ship client builds to Mike + testers  
3. Dual-run soak (legacy still open)  
4. Credential migration  
5. Close residual chat/invoice client writes if any remain  
6. Enforce secure rules  
7. Probe anonymous deny  
