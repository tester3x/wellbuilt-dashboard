# Dashboard spill route static-export fix — 2026-09-15

The dynamic /safety/spills/[incidentId] page prevented static export because incident IDs are runtime Firestore data and no generateStaticParams exists. Converted it to /safety/spills/?incidentId=...&companyId=..., matching the static Firebase Hosting architecture. Updated the list link, added Suspense for search parameters, and reject absent/path-shaped IDs before loading. Existing company capability checks remain in place.

Validation: npx next build --webpack passed compilation, TypeScript and all 26 static pages. out/safety/spills/index.html exists. Webpack is used because this isolated worktree shares node_modules through a junction, which Turbopack rejects; this is separate from the corrected route failure. No SSR conversion, function or rules deployment. Not deployed to Hosting.

This commit is separate from multi-task JSA settings so Desktop can cherry-pick the spill-route fix onto its active release without taking the unfinished template rollout. No real incident records were read or modified during testing. Old /safety/spills/<id> links must be replaced with the new query URL; no old-path redirect is included.
