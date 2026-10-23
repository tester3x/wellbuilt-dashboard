# Hosting release protection — October 23, 2026

Use `npm run deploy:hosting` from a clean, pushed `release/dashboard-*` checkout.
No Dashboard publication is needed to adopt these release-tool changes.

## Why the old check failed

The old gate proved ancestry from a September baseline. Both an incomplete release
branch and the branch with later approved fixes could descend from that baseline.
A successful build did not establish that the later fixes were retained.

## New enforced release path

1. Preflight freshly fetches `origin/release/dashboard-approved-base` and requires
   its commit to be an ancestor of HEAD. A stale or divergent branch must merge
   the checkpoint; missing refs and network failures block the release.
2. HEAD must exactly match the pushed remote release branch. Dirty work and
   unpushed commits are blocked. Existing baseline and clean-build checks remain.
3. Mandatory tests now also cover tab/scroll return state, office preferences,
   the driver arrival selector, release guards, and the full library suite.
   Media/date, Watchdog no-polling, header, Photo Review, responsive routes,
   autocomplete scroll, and forgot-password regressions remain mandatory.
4. After tests, acquire `release/dashboard-hosting-lock` using a normal Git push
   of a unique orphan commit. An existing lock rejects another release, even
   when both builds have the same source SHA.
5. Firebase uploads Hosting only. Its postdeploy hook checks unchanged source,
   freshly fetched checkpoint, lock ownership, and **all exported live bytes**,
   including public images. A mismatch or HTTP failure fails verification.
6. Only after successful verification, fast-forward the approved checkpoint to
   the exact source SHA, then release the lock. No force push is used. The
   ignored `.firebase/verified-hosting-release.json` records source, timestamp,
   checkpoint and every artifact hash.

The initial approved checkpoint is `0d603fd9a508013f12bfdc4478358d3e7e31826e`,
the continuing-source audit commit containing all restored Dashboard repairs.
It corresponds to the verified frontend release be7b7d59 with later source/audit
continuity. This is a source checkpoint, not a claim that a new site was deployed.

## Failure handling and limits

If an upload or verification fails after lock acquisition, leave the lock in
place until the release is investigated. The preflight receipt records its owner
in `.firebase/hosting-preflight.json`. Compare that owner with the remote lock,
confirm the original deploy is no longer running, and verify/recover Hosting
before deliberately clearing an abandoned lock. Do not advance the approved
checkpoint merely because the upload succeeded.

These controls enforce the repository's normal deployment path, including direct
Firebase commands that use the current firebase.json hooks. They cannot prevent
someone with independent Firebase deployment credentials from deliberately using
an old checkout/configuration or bypassing hooks. Provider-enforced exclusivity
would require moving Hosting credentials into a restricted CI deployment identity
and removing other deploy permissions; this change does not alter IAM or owners'
access. Do not describe local tooling as an absolute provider-side lock.

Regression tests use an isolated local bare Git repository: accepted current
source; rejected unpushed, old, divergent and dirty source; unreachable remote;
lock contention and ownership; complete binary/text verification; byte mismatch;
and HTTP failure. They do not publish to Firebase.
