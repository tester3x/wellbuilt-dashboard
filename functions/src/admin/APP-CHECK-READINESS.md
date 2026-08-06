# App Check readiness — vc51.9A6-B (Part 15)

## Current state (2026-08-06)

- **Administrator AUTHORIZATION** = verified Firebase Auth custom claim
  `wellbuiltAdmin === true` **AND** an exact enabled
  `platform_admins/{uid}` record, decided by
  `authorizeAdminCall` (authority.ts) on every call.
- **App Check** = client **authenticity / abuse control** — it attests
  the calling app, not the calling person.
- **Neither replaces the other.** App Check cannot grant admin
  authority; the admin gate cannot stop a scripted replay from a
  non-attested client. Both are required for the final posture.
- **Current App Check enforcement: OFF suite-wide.** No live
  enforcement was enabled in this packet.

## Prepared configuration

All 15 admin callables share `ADMIN_CALLABLE_OPTIONS` in
`callables.ts` with `enforceAppCheck: false`. Flipping that single
flag to `true` (one line) enforces App Check on every admin callable
at once. The flag's presence and off-state are pinned by
`tools/test-adminCallables.mjs`.

## Before enabling live enforcement (separate decision, NOT this packet)

1. Register the Dashboard web app with an App Check provider
   (reCAPTCHA Enterprise or v3) and roll attestation into the client.
2. Monitor App Check metrics in unenforced mode for a bake period.
3. Flip `enforceAppCheck: true`, deploy, verify admin flows.
4. Consider the same rollout for the existing security callables
   (`assertAppCheck` in security/driverAuthCallables.ts already
   soft-checks there).
