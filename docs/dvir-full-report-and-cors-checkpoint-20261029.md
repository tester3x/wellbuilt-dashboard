# DVIR full-report ingestion and signed media CORS checkpoint

Source lane: `tester3x/wellbuilt-dashboard`, registered home `D:/dev/Dashboard`, branch `release/dashboard-current-20260927`. Laptop's Equipment packet: `tester3x/wellbuilt-equipment/docs/DESKTOP-DVIR-CORS-AND-REPORT-INGESTION-NEXT-20261029.md` on `codex/wbe-shop-20261012`.

## Implemented in source

- New canonical `us-central1` callables: `getEquipmentInspectionReportCapabilities({schemaVersion:1})` and `submitEquipmentInspectionReport({schemaVersion:1,report,reportDigest})`. The feature is off until `WB_EQUIPMENT_FULL_DVIR_ENABLED=true` is set for a scoped Functions release. Both use live canonical driver authority; the report company comes from that authority, not the request.
- The report validator accepts signed `dvir-report/2` payloads with truck/trailer assets, area/item attribution, issues, phases and amendments. It checks the 800000-byte bound, canonical SHA-256 digest, identity graph, signature acknowledgement, and optional published profile provenance. JSON object keys are recursively sorted and undefined object properties are omitted before hashing and storage. Legacy nine-category submission is retained.
- Immutable Firestore records go under `companies/{companyId}/equipment_inspection_reports/{opaqueDocumentId}`. The document ID is derived from canonical company/driver plus inspection ID, phase, report ID and version. A matching retry returns the same receipt; a changed digest conflicts. The full frozen report is the source of truth. Two read callables provide company-authorized list/detail access; the Dashboard DVIR tab has an optional full-report viewer gated by `NEXT_PUBLIC_DVIR_FULL_REPORTS_ENABLED=true`.
- Local-only defect evidence references are rejected, rather than falsely acknowledged as uploaded. Remote evidence IDs are also rejected until an ownership-verifiable media record contract exists. The phone must keep such reports retryable locally. There is no PDF upload or direct client Firestore fallback.

## Live Storage CORS finding and exact proposed change

The canonical bucket is `wellbuilt-sync.firebasestorage.app`. Read-only inspection on 2026-10-29 found this CORS entry:

```json
{"origin":["*"],"method":["GET","POST","PUT","DELETE","HEAD"],"responseHeader":["Content-Type","Authorization","Content-Length","User-Agent","x-goog-resumable"],"maxAgeSeconds":3600}
```

An XML-endpoint OPTIONS request from `https://wellbuilt-sync.web.app` for PUT with `content-type,x-goog-if-generation-match,x-goog-meta-sha256` returned HTTP 200 without Access-Control-Allow headers. The bucket's configured `responseHeader` list is missing the two required signed PUT headers. [Google Cloud's XML API CORS documentation](https://docs.cloud.google.com/storage/docs/cross-origin) says it checks requested headers against that list. Proposed smallest additive change: retain the current origin `*` and every current method/header to avoid breaking existing consumers, and append `x-goog-if-generation-match` and `x-goog-meta-sha256` to `responseHeader`. The wildcard already includes the Dashboard origin; narrowing it would be a separate cross-product decision.

Proposed CORS entry:

```json
{"origin":["*"],"method":["GET","POST","PUT","DELETE","HEAD"],"responseHeader":["Content-Type","Authorization","Content-Length","User-Agent","x-goog-resumable","x-goog-if-generation-match","x-goog-meta-sha256"],"maxAgeSeconds":3600}
```

Rollback is the exact original entry above. Before applying, re-read live CORS and require exact equality with the original; preserve any concurrent change instead of overwriting it. A bucket CORS update is live shared infrastructure, and no update has been applied. The follow-up must run OPTIONS against the actual signed URL, then an isolated generation-zero signed PUT/read and negative overwrite, expiry, and signed-header checks. The photo-upload callable and defaults are not deployed, so this live round trip is still pending. The deployed Storage rules remain the audited deny-by-default rules; never deploy the checked-in broad `storage.rules`.

## Release limits

No Functions, Hosting, CORS, rules, default catalogue, APK, or customer data were changed live. `WB_EQUIPMENT_FULL_DVIR_ENABLED` and `NEXT_PUBLIC_DVIR_FULL_REPORTS_ENABLED` are off by default. A future release must verify the app's digest/receipt protocol against this endpoint, implement or explicitly defer remote defect media ownership, resolve historical shift ownership and full report authorization expectations, run emulator and live isolated round trips, then enable capabilities and the viewer in a scoped deployment. The app's currently installed E107 is not this source.
