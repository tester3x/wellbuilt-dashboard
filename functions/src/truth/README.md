# Truth Layer — Shadow Endpoints (Phase 6)

Read-only admin-gated wrappers over the truth/canonical stack in
`../truth-layer/`. Nothing here replaces any existing endpoint.

## Endpoints

All are `onCall` (v2). All require the caller's Firebase Auth UID to have
role `admin` or `it` in RTDB `users/{uid}`. Input shape (all four readers):

```
{ date: "YYYY-MM-DD", companyId?: string }
```

| Name                            | Returns                                             |
| ------------------------------- | --------------------------------------------------- |
| `getIntegratedTruthForDay`      | `{ bundle: IntegratedTruthBundle, sourceErrors, loaded }` |
| `getDashboardReadModelForDay`   | `{ model: DashboardReadModel, sourceErrors, loaded }`     |
| `getRAGIngestBundleForDay`      | `{ rag: RAGIngestBundle, sourceErrors, loaded }`          |
| `getShadowComparisonForDay`     | `{ shadow: ShadowComparisonBundle, sourceErrors, loaded }`|

Plus one derived-output writer:

| `exportTruthRagForDay` | Writes raw + canonical RAG records to `truth_rag_exports/{runId}` and returns the runId + stats. |

## Phase 7 additions — first controlled production read consumer

| `getTruthDriverDaySummary` | Per-driver day summary from the truth/canonical stack. Backs the Truth/Compare toggle on `/driverlogs`. |

## Phase 8 additions — operationalized export lane

Shared core lives in `truthRagExportCore.ts` (`runTruthRagExport`). All
writers go through it and produce full manifest transitions:
`started → completed | failed` with `startedAt` / `completedAt` /
`durationMs` / `notableFindings`.

| `exportTruthRagForDay` (upgraded) | Manual manifest with `mode:'manual'`. Honors caller-supplied `runId` (overwrite). |
| `rerunTruthRagExportForDay`       | `mode:'rerun'`, ALWAYS a new `runId`, optional `reason` stored in manifest. Older runs untouched. |
| `listTruthRagExports`             | Read-only. Newest-first by `(date desc, startedAt desc)`. Manifest fields only — never loads subcollections. Filters: `dateFrom`, `dateTo`, `companyId`, `limit` (max 100). Hauler-scoped admin is pinned to its own `companyId`. |
| `getTruthRagExportRun`            | Read-only. Manifest + `count()` of each subcollection + deterministic samples (`orderBy(FieldPath.documentId()).limit(N)`, N default 10, max 50). |
| `prepareScheduledTruthRagExport`  | **Template only** — not an exported Cloud Function. Shows how a future `onSchedule(...)` handler would call `runTruthRagExport(mode='scheduled_prep')`. Promotion to a live schedule requires a separate approved phase. |

## Auth

`requireAdminRole.ts` reads RTDB `users/{uid}` — the same path the frontend
uses — and rejects with `HttpsError` if absent or role is not `admin`/`it`.
No new auth system, no broadening. WB admin sees everything;
hauler-scoped admins are constrained to their `companyId` (server-side override
is honored only when it matches the caller's company).

## Data sources

`loadTruthInputForDay.ts` fetches best-effort, partial-OK:

| Source     | Path                                 | Filter                                    |
| ---------- | ------------------------------------ | ----------------------------------------- |
| drivers    | RTDB `drivers/approved`              | optional top-level `companyId`            |
| shifts     | Firestore `driver_shifts`            | docId suffix `_{date}` + optional companyId |
| invoices   | Firestore `invoices`                 | `createdAt` range `[00:00Z, 23:59Z]` + optional companyId |
| dispatches | Firestore `dispatches`               | `assignedAt` range same + optional companyId |
| jsas       | Firestore `jsa_day_status`           | docId suffix `_{date}` + optional companyId |

Per-source failures are captured in `sourceErrors[]` rather than aborting.
Production, `well_config`, NDIC/MBOGC catalog, and route data are not loaded
in this shadow pass — the truth layer handles sparse inputs by design.

## Destination: `truth_rag_exports`

This collection is derived-output only. It is never read by any operational
code path. Schema:

```
truth_rag_exports/{runId}
  date, companyId?, generatedAt, triggeredBy.{uid,role},
  loaded.{drivers,shifts,invoices,dispatches,jsas},
  stats.{rawCount,canonicalCount,eventCount,jsaRecordCount,sessionRecordCount,summaryRecordCount},
  sourceErrors[], warningCount

truth_rag_exports/{runId}/raw_records/{autoId}        ← RAGRecord
truth_rag_exports/{runId}/canonical_records/{autoId}  ← CanonicalRAGRecord
```

`runId` default: `${date}_${companyId || 'all'}_${epochMs}`. Callers may pass
an explicit `runId` to overwrite a prior run. Writes are chunked 400 records
per `batch.commit()` (under the 500-ops cap).

Retention: no TTL policy yet. Remove manually when space matters. A scheduled
cleanup is deliberately out of scope for Phase 6.

## Keep in sync with `C:\dev\claude-home\shared\truth-layer`

This directory's sibling `../truth-layer/` is a copy of the canonical
`C:\dev\claude-home\shared\truth-layer\` source. Re-copy on any truth-layer
change and re-run `tsc --noEmit` from the functions root before deploying.
The canonical source is the authority; the local copy is a build artifact.

## Not covered by Phase 6

- no scheduled export trigger (callable is manual-only)
- no deletion/overwrite sweep of prior runs
- no vector-DB push
- no frontend ingest consumer
- no production-path replacement of existing endpoints
