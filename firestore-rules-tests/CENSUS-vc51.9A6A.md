# VC51.9A6-A — Rule-Overlap Census + Company Writer Census (2026-08-06)

Read-only census taken at: Dashboard bdc0712, wellbuilt-ticket 837833a,
JSA 5bdfd02, Suite / WB-M / wb-equipment-dvir-stage (read-only HEADs),
Dashboard functions included. Authoritative rules file:
`D:\dev\Dashboard\firestore.rules` (wired by `firebase.json` →
`"firestore": { "rules": "firestore.rules" }`). `firestore.rules.secure`
and WB-T's repo-local `firestore.rules` copy are stale/unwired and were
not modified.

---

## Part 2 — Complete rule-overlap census (pre-change rules)

Firestore rules are OR-combined across every matching `match` block: a
`allow ...: if false` in one block NEVER restricts an `allow ...: if true`
in another. Order is irrelevant.

### companies/{companyId} (root document)

| Matching block | get | list | create | update | delete |
|---|---|---|---|---|---|
| `match /companies/{docId}` (the broad grant) | true | true | true | true | true |
| `match /{document=**}` catch-all (deny) | false | false | false | false | false |
| **Net (OR)** | **true** | **true** | **true** | **true** | **true** |

- Two blocks overlap on this path. The catch-all is deny-only, so the
  overlap adds nothing — but the broad `allow read, write: if true`
  grants EVERY operation to ANY unauthenticated client. This is the
  defect this packet removes for writes.
- The `companies` match is single-segment (`{docId}`, not
  `{document=**}`), so it grants nothing to subcollection documents.

### Nested company paths

Each explicitly matched subcollection has exactly one specific block plus
the deny catch-all (no effective overlap):

| Path | Net behavior |
|---|---|
| `companies/{id}/swd_directory/{e}` | read+write true (unauthenticated) |
| `companies/{id}/counters/{c}` | read+write true — **no writer exists in ANY repo** (declared for "Dashboard Add Pull"; nothing references it, incl. WB-T) |
| `companies/{id}/equipment_specs/{s}` | read+write true (Dashboard writes, WB-T reads) |
| `companies/{id}/equipment/{e}` | read true, write false |
| `companies/{id}/equipment_types/{t}` | read true, write false |
| `companies/{id}/assignments/{a}` | read false, write false |
| `companies/{id}/dvir_inspections/{i}` | read false, write false |
| `companies/{id}/<anything else>/{d}` | catch-all only → all denied |

### plans/{planId}, platform_admins/{uid}, admin audit

No specific block exists pre-change; each is matched ONLY by the deny
catch-all → get/list/create/update/delete all denied today. This packet
adds explicit deny blocks so the protection is pinned rather than
incidental. Proposed audit collection name (pinned for Part B):
`platform_admin_audit`.

### Company entitlement / configuration data

The planned contract fields live ON the company root document, so
pre-change they are governed by the broad `write: if true` — any
unauthenticated client could pre-seed, alter, or erase them. That is the
concrete risk motivating this packet.

### Catch-all / recursive audit

- Exactly ONE `match /{document=**}` exists (file tail), deny-only.
- No recursive (`{document=**}`) match exists under `/companies`.
- No duplicate `match /companies` block exists.
- Similarly named but UNRELATED top-level collections (keyed by
  companyId, not under `/companies`): `billing_counters/{companyId}`,
  `billing_invoice_counters/{companyId}`, `jsa_templates/{companyId}` —
  all `read, write: if true` today; out of scope for this packet.

Pinned by: `test-rulesSourcePins.mjs` (single companies block, deny-only
catch-all, no broad companies write grant) + the emulator matrix (a
protected write denied under EVERY identity proves no overlapping grant
restores it).

---

## Part 3 — Complete company writer census

Method: four independent sweeps (Dashboard incl. functions; wellbuilt-
ticket incl. functions; JSA; Suite + WB-M + wb-equipment-dvir-stage)
covering updateDoc / setDoc(±merge) / addDoc / deleteDoc / transactions /
batches / writeBatch / REST PATCH±updateMask / REST PUT / `:commit` /
`:batchWrite` / Admin SDK writes / generic path-building helpers whose
collection argument could resolve to `companies`.

### Headline

**Every write to the company ROOT document originates in the Dashboard
browser client (Firebase-Auth signed in) or in Cloud Functions (Admin
SDK).** WB-T, WB-JSA, WB-S, WB-M, and eQuipment contain ZERO company
writers — root or subcollection. No generic helper in any repo can
resolve a write to `companies`.

### A. Company ROOT document writers (all Dashboard)

| # | Site | Op | Merge? | Fields | Breaks under new rules? |
|---|---|---|---|---|---|
| 1 | `src/lib/companySettings.ts:529` `updateCompanyFields` — 30+ callers across `src/components/settings/*` and `src/app/billing/page.tsx:309` | `updateDoc` | field-merge (RE-PROVEN: `updateDoc` only replaces the named top-level keys; dotted path `payConfig.payrollTemplate` merges within the map; the file imports no set/delete API) | name, address, city, state, zip, phone, invoicePrefix, ticketPrefix, invoiceBook, notes, logoUrl, thermalLogoUrl, primaryColor, billingConfig, rateSheets, payConfig, `payConfig.payrollTemplate` (dotted), roleLabels, roleCapabilities, activePackages, customJobTypes, assignedOperators, ticketTemplates, sendLevelToDispatch, levelReportTemplate, requirePhotos, minPhotoCount, photoRetentionDays, splitTickets, transferRequiresApproval, liveDispatchSync (incl. `deleteField()`), cancelledNumberHandling, invoicingMode, jsaMode, jsaJobPolicy, jsaAllowAcknowledge, emergencyContacts, companyContacts, doeRegion | No — authenticated; never touches a protected key |
| 2 | `src/components/admin/CompaniesTab.tsx:162` `activatePendingSignup` | `setDoc` NO merge | **replace/create** | name, status | No — create/replace without protected keys |
| 3 | `CompaniesTab.tsx:253` `saveCompany` (edit) | `updateDoc` | field-merge | name, address?, city?, state?, zip?, invoicePrefix?, invoiceBook, transferRequiresApproval, wellMonitoring, ticketPrefix?, phone?, notes? | No |
| 4 | `CompaniesTab.tsx:256` `saveCompany` (create) | `setDoc` NO merge | **replace/create** | same as #3 | No on unconfigured docs. **Once a company carries protected fields, this replacement is DENIED (by design — it would erase them).** Pre-existing data-loss landmine on ordinary fields (replaces rateSheets/payConfig/etc.) is unchanged for legacy docs. |
| 5 | `CompaniesTab.tsx:271` `deleteCompany` | `deleteDoc` | delete | — (orphans subcollections) | No for legacy docs. **Denied on companies carrying protected fields (by design; migration to callable required before Part B configures companies).** |
| 6 | `CompaniesTab.tsx:318/338/387/426/606/853` | `updateDoc` | field-merge | assignedOperators, rateSheets, payConfig, logoUrl?, primaryColor?, tier | No |
| 7 | `src/lib/billing.ts:581` `saveDieselPrice` | `updateDoc` | field-merge | currentDieselPrice | No |
| 8 | `functions/src/index.ts:2393` `weeklyDieselPriceFetch` (scheduled) | Admin `.update()` | field-merge | currentDieselPrice | No — Admin SDK bypasses rules |
| 9 | `functions/src/index.ts:2450` `triggerDieselFetch` (`onRequest`, CORS open, unauthenticated HTTP) | Admin `.update()` | field-merge | currentDieselPrice | No — Admin SDK bypasses rules. (Exposure noted: endpoint itself is unauthenticated — outside this packet's scope.) |

`updateCompanyFields` merge-safety RE-PROVEN as required: it is a bare
`updateDoc(doc(db,'companies',id), fields)` — Firestore `update` semantics
replace only the supplied top-level keys (dotted paths merge deeper),
never the whole document, and fail if the doc is absent. No caller passes
a protected key (full caller sweep above).

### B. Company SUBCOLLECTION writers

| Site | Path | Op | Client/Admin |
|---|---|---|---|
| Dashboard `src/lib/vehicleDocuments.ts:266` | `equipment_specs/{type}_{n}` | `setDoc` merge:true | client (auth'd) |
| Dashboard `src/components/settings/SWDDirectoryCard.tsx:163/165/188` | `swd_directory/*` | setDoc NO merge / addDoc / deleteDoc | client (auth'd) |
| Dashboard functions `equipment/services/equipmentService.ts:182,214,252,314` | `equipment_types/*`, `equipment/*` | Admin set (mixed merge) | Admin SDK |
| Dashboard functions `equipment/services/assignmentService.ts:269,320,423-424` | `assignments/*` | Admin tx.set | Admin SDK |
| Dashboard functions `equipment/services/dvirService.ts:238-240` | `dvir_inspections/*` | Admin set | Admin SDK |
| — | `counters/*` | **no writer in any repo** | — |

Subcollection rules are UNCHANGED by this packet; their behavior is
regression-covered in the matrix.

### C. Driver/profile writes (distinguished — NOT company docs)

RTDB `drivers/approved/*`, `drivers/pending`, `users/{uid}`,
`devices/company/{deviceId}` (WB-M RTDB, name look-alike only) — all
Realtime Database, untouched by Firestore rules.

### D. Unrelated similarly named paths

`billing_counters/{companyId}`, `billing_invoice_counters/{companyId}`,
`jsa_templates/{companyId}` (top-level, read-only from JSA app),
`jsa_day_status` / `jsas` / `jsa_completions` writers in WB-T/JSA — none
can resolve to `/companies/*`.

### E. Per-app read exposure (why company `read: if true` must stay)

- WB-T: `getCompanyConfig` getDoc + `onSnapshot` + **`getAllCompanies`
  getDocs (collection LIST)** — unauthenticated client.
- WB-JSA: REST GET company doc (no API key!) + `getDoc` tier.
- WB-S (Suite): REST GET company doc unauthenticated (config, packages,
  payConfig/rateSheets, jsaMode).
- WB-M: `getDoc` tier.
- Dashboard: authenticated reads throughout; functions Admin reads.

Both exact-get AND collection-list must remain open for installed apps.
Honest exposure: any holder of the public API key can read all company
docs (incl. payConfig / rateSheets). Narrowing requires the suite-wide
auth/App Check rollout — out of scope here.

### F. Census conclusions feeding the rules change

1. No legitimate client writer of companies is unauthenticated →
   company create/update/delete can require `request.auth != null`.
2. No writer touches any protected contract key → the protected-key
   guard breaks nothing that exists today.
3. Legitimate direct-client create (CompaniesTab) and delete
   (deleteCompany) flows EXIST → preserved for authenticated clients on
   docs without protected fields; denied once protected fields exist
   (delete/replace of a configured company must migrate to a callable —
   reported as the Part B migration item, not silently left open).
4. Whole-document replacement (`setDoc` no-merge on existing doc) is an
   `update` in rules terms → the MapDiff guard denies it whenever it
   would add/modify/REMOVE any protected key, which is exactly the
   erase-protection required.
