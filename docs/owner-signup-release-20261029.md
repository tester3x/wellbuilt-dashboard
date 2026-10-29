# New owner/company signup release

User decision: continue the new owner signup implementation; keep the legacy WB approval implementation parked. No legacy platform authorization guard was removed.

Laptop registered home: `C:/dev/dashboard-current-20261004`; remote `https://github.com/tester3x/wellbuilt-dashboard.git`; release branch `release/dashboard-owner-signup-20261029`; owner session `01a139b5-d3f7-7401-bdf0-3443ec841c28`.

Source reconciles desktop `a8c1b6f93b9ae3668566491fc0a7c160a1d5d06c`, original laptop integration `d215b879cefcd3c995449414fadd9107965cacf0`, and approved Hosting checkpoint `563e374c75fdeb298491f1f18b68447df4f36929`, preserving their histories and the pull-delete repair.

## Implemented

- Owner registration creates a new isolated company, canonical app driver identity with scrypt credentials, email Dashboard membership, company-scoped trusted admin records, join code, free JSA/DVIR plan and initialized empty shift authority. It cannot adopt another company, driver identity or platform administrator.
- A durable provisioning journal lets an authenticated owner retry an interrupted setup without creating another company or driver. Existing company accounts and revoked records are refused. The web wrapper proves an existing email account's password before retrying.
- Registration and welcome pages explain Dashboard email versus app sign-in name. No employee code or shift is required for standalone JSA/DVIR. Tickets and Mobile are explicitly excluded from the free plan.
- Marketing site `C:/dev/wellbuilt-site`, `main`, source `7a9ecd0e1ebe18954377457e86da59d0d051bc8d` adds Create Account/Get Started links and repairs the missing mobile-menu expanded layout. GitHub Pages publishes main; its exact live verification is recorded separately.

## Built / deployed / verified

- Functions source `ab549a426d54f55146b62eb0946b2496b9c8ce84`: compiled successfully. Only `createOwnerCompany` and `getOwnerCompanySetup` were deployed to project `wellbuilt-sync`, region `us-central1`, codebase `dashboard`. Both list ACTIVE. Live unauthenticated requests return HTTP 401 / UNAUTHENTICATED. No other Functions, rules, bucket settings or customer records were deployed/changed by this release.
- Hosting source `2107dd9134dbfa7f0507448943f45bfc15299bd5`: `npm run deploy:hosting` passed all certified preflight checks, uploaded successfully and byte-verified 389 live artifacts at `2026-10-29T23:05:44.921Z`. Remote approved checkpoint advanced normally; shared Hosting lock released by the postdeploy hook.
- Focused server tests: 56 passed across owner signup, prior onboarding identifiers/lineage and empty shift authority. Owner signup has 23 tests including real contract parsing/entitlement decisions, interruption recovery, password hashing, name collisions, reserved privileges and revocation protection.
- Actual web auth wrapper tests passed for new signup, same-account reauthentication, existing-account password proof, interrupted retry and validation. Dashboard TypeScript and production compilation passed. Certified retained-behavior checks passed, including the 500-test frontend suite (499 passed, one skipped), header/photo contracts, forgot-password and all 28 responsive routes.
- Marketing navigation tested in Chromium at 360/768/1280px. The signup entry is visible and within the viewport, including the mobile menu.

## Still requires real user verification

Mike was given `https://wellbuilt-sync.web.app/register/` to register Hots Oiler LLC with a separate email from Liquid Gold and a private chosen password. No company or account was pre-created and no safety acknowledgement/signature was fabricated. Successful real signup, Dashboard owner access and JSA/WB e app sign-in remain unverified until that round trip occurs.

Hot-oiler profile publication and the new DVIR media/report rollout are separate pending work. Their Dashboard flags remain OFF; this signup release does not make those profiles/photos available. No APK was built or installed.
