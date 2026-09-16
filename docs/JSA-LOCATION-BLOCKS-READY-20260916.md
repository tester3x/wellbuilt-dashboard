# JSA location block controls — 2026-09-16

Source commit: `219ece4fa64d9001603ffdc5fe749b69e5f319f6`

The JSA template editor now lets a customer place two repeatable sections in its published layout:

- **Locations Covered**: after job details, after the assessment, or after the signature.
- **Location-Specific Differences**: after the assessment or after the signature.

New templates receive the standard placements automatically. Older templates display the defaults and persist them the next time they are edited and published. Published immutable revisions retain the selected placement. When multiple selected task templates have conflicting placement settings, the mobile renderer uses its universal addendum instead of guessing.

Validation:

- `npx tsc --noEmit` passed.
- `node tools/test-jsaTemplatePublication.cjs` passed.
- `npx next build --webpack` passed and exported 26 pages.

The normal Turbopack build remains affected by the worktree `node_modules` symlink being outside its filesystem root. The webpack production build is clean.

Dashboard Hosting was not deployed from this isolated branch. This commit is ready to integrate into the accepted dashboard release lineage before the next dashboard deployment.
