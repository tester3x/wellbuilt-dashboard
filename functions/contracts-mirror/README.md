# @tester3x/wellbuilt-contracts

Pure, environment-neutral contracts shared by the WellBuilt Suite
(Dashboard, WB-T, WB-JSA, WB-S): plan entitlements, company work-period
configuration, and the **canonical work-period resolver**.

## Why

On 2026-08-06 a closed shift stayed "current" in WB-JSA while WB-T fell
back to a UTC date. Two apps disagreed about the driver's work period, so
a job started with no valid period and yesterday's JSA was presented as
today's. Duplicated per-app helpers made that drift invisible. This
package makes the period decision *one* decision.

## Guarantees

- No Firebase, AsyncStorage, React/Expo, network, filesystem, or secrets.
  Callers fetch evidence; the package only decides. (Pinned by a purity
  test over `src/`.)
- Local cache and deep links are HINTS. Only fetched authoritative day
  documents establish an explicit shift.
- A closed or superseded explicit shift never becomes current again.
- Resolution failure surfaces as `UNVERIFIED_OFFLINE` — never "last known
  shift".
- Derived periods come from the company IANA timezone + schedule, never a
  UTC-date fallback. Missing/invalid configuration fails honestly.

## Outcomes

`ACTIVE_EXPLICIT_SHIFT` · `CURRENT_DERIVED_PERIOD` · `NO_ACTIVE_SHIFT` ·
`CLOSED_OR_SUPERSEDED` · `UNVERIFIED_OFFLINE` · `INVALID_CONFIGURATION`

Use `isOperationallyOpen()` to authorize new work and
`mayBindRequestEvidence()` before signing/filing/receipt writes.

## Version handshake

`assertContractCompatible(doc.contractVersion, 'wb-t')` — an app must never
silently consume an unknown future contract version.

## Conformance

`@tester3x/wellbuilt-contracts/conformance` exports `CONFORMANCE_CASES`. **Every consumer runs them**
against its installed copy, so drift fails a test instead of stranding a
driver. Covers: explicit open/closed/superseded/overnight, the 8/6 field
case, same-day close, missed logout, offline, deep-link disagreement,
derived 06:00–18:00 and 18:00–06:00, DST spring/fall in America/Chicago,
invalid timezone, missing configuration, and version refusal.

## Distribution

Canonical home: **https://github.com/tester3x/wellbuilt-contracts**
(private). Published privately to GitHub Packages, semver, exact-pinned
by every consumer:

```
# .npmrc (consumer — tracked; the token is ALWAYS an env reference)
@tester3x:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}

npm install @tester3x/wellbuilt-contracts@0.1.0 --save-exact
```

`file:` links, vendored tarballs, and copied helpers are NOT acceptable
production mechanisms. Published versions are immutable.

### Required credentials (never tracked; classic PAT with read:packages)

- **Local development**: `NODE_AUTH_TOKEN` in the developer shell
  (`gh auth token` works when the gh session carries read:packages).
- **CI**: repository/organization secret `NODE_AUTH_TOKEN`.
- **Dashboard Functions deployment**: the deploy environment needs
  `NODE_AUTH_TOKEN` at `npm ci` time (Functions bundles its
  node_modules at deploy; the runtime needs no token).
- **Dashboard hosting build**: `NODE_AUTH_TOKEN` in the build
  environment.
- **EAS Android / EAS iOS**: an EAS secret `NODE_AUTH_TOKEN` consumed by
  the build profile (NOT configured in this packet).

### Adopting in WB-S / WB eQuipment (future packets)

Use exactly the coordinates above: add the two `.npmrc` lines, then
`npm install @tester3x/wellbuilt-contracts@0.1.0 --save-exact`, run the
conformance suite against the installed copy, and never import a local
copy. WB-M requires no adoption.

## DST edge behavior (documented, not incidental)

Local wall times resolve through a two-pass zone-offset calculation. A
spring-forward nonexistent local time resolves forward past the gap; a
fall-back ambiguous local time resolves to its first (pre-transition)
occurrence.
