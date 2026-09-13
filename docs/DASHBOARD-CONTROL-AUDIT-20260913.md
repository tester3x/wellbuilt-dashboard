# WellBuilt Dashboard — Exhaustive Control Audit (2026-09-13)

Branch: `audit/dashboard-controls-20260913` (from live `eef9d014`). Repairs across commits
`6496a002`, `ec65e70b`, `95815fc0`. No Functions / rules / auth / identity / DB-target changes.

## Classification legend
- **WORKING** — full chain verified end-to-end (governed callable enforces authority; client gate + payload + busy + success + failure all correct).
- **LOCAL/READ-ONLY** — no server mutation (client state, navigation, external read, download).
- **UI CONTAINED / SERVER EXPOSED (CE)** — client capability gate + honest UI present, but the write is a direct Firestore/RTDB/Storage mutation the deployed rules still permit for any authenticated caller. `CE (repaired)` = UI defect fixed this audit; server exposure remains (rules-lane).
- **BLOCKED** — control cannot complete without a missing governed backend contract; disabled or fails honestly.
- **DEAD/NO-OP** — no handler / no effect.
- **LEGACY/UNREACHABLE** — render condition never true / superseded.

Evidence key: `RT`=runtime mock-invoker test; `SC`=structural contract test; `GR`=render/guardrail; `RO`=read-only reasoning.

Systemic note: the deployed Firestore rules allow any authenticated write to non-protected `companies/{id}`; `companies/{id}/swd_directory`, `chat_threads`, `chat_monitors`, `diesel_prices`, `deductions`, `additions`, `projects`, `photo_requirements` are governed only by (permissive/absent) rules; the repo `database.rules.json` is globally open. Every **CE** row depends on the rules-lane fix (route through the deployed-but-unused `adminUpdateCompanySafe`, or a new governed callable, + tighten rules). Client gates are containment, not closure.

---

## `/` (src/app/page.tsx)
| Control | Render cond | Capability | Handler→Target | Busy | Success/Failure UI | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| WB Mobile card | `hasCapability(viewMobile)` | viewMobile | `<Link>` /mobile | – | nav | LOCAL | 6496a002 (gate added) |
| WB Tickets card | `hasCapability(viewTickets)` | viewTickets | `<Link>` /tickets | – | nav | LOCAL | 6496a002 |
| WB Billing card | `hasCapability(viewBilling)` | viewBilling | `<Link>` /billing | – | nav | LOCAL | 6496a002 |
| WB Payroll card | `hasCapability(viewPayroll)` | viewPayroll | `<Link>` /payroll | – | nav | LOCAL | 6496a002 |
| Stat counts (wells/tickets/invoices) | always | canViewGlobalWellPool (wells) | RTDB `packets/outgoing` + Firestore reads | – | render | LOCAL/READ-ONLY | – |

## `/mobile` (src/app/mobile/page.tsx)
| Control | Render cond | Capability | Handler→Target | Busy | Success/Failure UI | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| +Add Pull (entry) | `canAddPull` | createDispatch | opens AddPullModal + lazy adminGetDashboardCatalog | – | modal opens; catalog err → console (minor) | CE (repaired: entry gated) | 6496a002; submit BLOCKED (below) |
| Well search + clear | always | – | client filter | – | list filters | LOCAL/READ-ONLY | – |
| Performance link | always | – | nav /performance | – | nav | LOCAL | – |
| Expand/Collapse All, route expand | always | – | localStorage | – | toggles | LOCAL/READ-ONLY | – |
| Table/Cards toggle, sort headers (7), PullBbls slider+reset, Unrouted show-all, Edge-Case toggle | always | – | useState | – | view only ("visual planning only") | LOCAL/READ-ONLY | – |
| Well name links | always | – | nav /well?name= | – | nav | LOCAL | – |

## AddPullModal (src/components/AddPullModal.tsx) — reached from /mobile & /dispatch
| Control | Render cond | Capability | Handler→Target | Busy | Success/Failure UI | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| Submit Pull (`handleSubmit`) | in modal | (entry gated createDispatch) | direct RTDB `set packets/incoming/{packetId}` + Firestore invoices/tickets/counters | submitting flag | partial-fail message honest | **BLOCKED** | Needs governed staff pull-ingest callable that **server-issues packetId + idempotency key** (client id is deterministic `<ts14>_<well>_dashboard` → collision/overwrite) and server-derives identity/company; existing ingestDriverPacket/ingestWbmPull require a driver token |
| Create-Ticket toggle, driver/bottom/drop-off/level/bbls/datetime inputs, Cancel | in modal | – | form state | – | local | LOCAL/READ-ONLY | – |

## `/tickets` (src/app/tickets/page.tsx) + TicketDetailModal
| Control | Render cond | Capability | Handler→Target | Busy | Success/Failure UI | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| Search | always | – | client filter | – | filters | LOCAL/READ-ONLY | – |
| Refresh | always | – | `fetchTickets` (read) | `disabled={dataLoading}` | error banner | WORKING (read) | – |
| Ticket row click | always | – | opens modal | – | modal | WORKING | – |
| Invoice # button | always | – | nav /billing?search= | – | nav | LOCAL | – |
| TicketDetailModal load | on open | – | fetchInvoiceForTicket + fetchSiblingTickets | loading flag | now `.catch` → error text (was permanent spinner) | WORKING (read) | 6496a002 |
| Modal close/backdrop, sibling nav, photo/JSA links | in modal | – | onClose / nav / Storage read | – | – | WORKING | – |

## `/well` (src/app/well/[wellName]/page.tsx)
| Control | Render cond | Capability | Handler→Adapter→Target | Payload | Busy | Success/Failure | Evidence | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|---|---|
| Pull Delete | `canDeletePull` | manageDrivers/pool (server) | confirmDelete→deletePull→runDeletePull→`staffDeletePull` | `{packetId, wellName}` | `deleteSubmitting`, double-submit guard, no optimistic remove | refresh from server / `describeDeleteError` banner, modal persists on fail | RT (dispatchControlsRuntime) | **WORKING** | prior phase |
| Pull Edit | `canEditPull` | server | submitEdit→editPull→`adminSubmitPullEdit` | edit payload | submitting | governed; error surfaced | RT (pullEditCore) | **WORKING** | prior phase |
| Tenant empty state | `!canViewGlobalWellPool` | – | render | – | – | – | RO | WORKING | – |

## `/performance`, `/performance/route`, `/performance/well`
| Control | Render cond | Capability | Handler→Target | Busy | Success/Failure | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| Data load (all 3) | auth + canViewGlobalWellPool | (read; adminGetWellPerformance fallback enforces server) | buildPerformanceSummary / fetchWellPerformance (RTDB read) | loading | overview+well pages: classifiedReadFailure banner | LOCAL/READ-ONLY | – |
| **route page** load error | – | – | – | – | now loadError banner + Retry (was silent "no data") | LOCAL/READ-ONLY (repaired) | 6496a002 |
| Route/well cards (links), sort buttons, retry | always | – | nav / useState / reload token | – | – | LOCAL/READ-ONLY, WORKING(nav) | – |

## `/photo-review` (src/app/photo-review/page.tsx)
| Control | Render cond | Capability | Handler→Adapter→Target | Payload | Busy | Success/Failure | Evidence | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|---|---|
| Search / All Photos / Load More / Retry | `canView` + company | viewDispatch | executeQuery→`listDispatchPhotoReviews` | filters + limit | `loadState` disables | list renders / error banner; hasMore uses server count | SC | WORKING (read) | 6496a002 (pagination fix) |
| Approve / Reject / Address (card + inspector) | `canMutate` | **createDispatch** (was role denylist) | runReview→`reviewDispatchPhoto` | `{companyId,invoiceId,photoId,action[,reason,note]}` | per-card `cardBusy` | card updates / error surfaced | SC | WORKING | 6496a002 (gate corrected) |
| Company selector, filters, thumbnail inspector, clear | always | – | local state | – | – | LOCAL/READ-ONLY | – |

## `/dispatch` (src/app/dispatch/page.tsx) — capability-funneled (Phase 2) + project gates (Phase 4B)
| Control (group) | Render cond | Capability | Handler→Adapter→Target | Busy | Success/Failure | Evidence | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|---|
| PW dispatch, Bulk dispatch, Service Work (+split), Cancel, Dismiss, Reassign, Edit SW/PW, PW split, Cancel SW-assign, Transfer approve/deny, Edit-completed save | dispatch board | createDispatch (guarded wrappers `staffCreateDispatch`/`staffUpdateDispatch`/`staffCancelDispatch`/`dismissDispatch` → `_`-adapters) | `staffWriteDispatch{op:create|update|cancel}` / `dismissDispatch` | submit flags on primary buttons | governed; errors via setMessage/alert | RT (dispatchControlsRuntime) | **WORKING** | prior phase |
| Auto group-chat thread (multi-driver dispatch) | on multi-driver | createDispatch (via handler) | `addDoc chat_threads` + messages | – | – | RO | CE | rules-lane / staff chat callable |
| Create Project | projects tab | createDispatch (`guardCreateDispatch`) | `addDoc projects` (+chat) then `staffCreateDispatch`×N | `creatingProject` | error toast; guard prevents orphan project for view-only | SC | CE (repaired: gated) | ec65e70b; rules-lane |
| Project status active/pause/complete | project detail | createDispatch (guard) | `updateDoc projects` | – | – | SC | CE (repaired) | ec65e70b |
| Add driver today / Batch dispatch shift | project detail | createDispatch (guard) | `updateDoc projects` + `staffCreateDispatch`×N | – | – | SC | CE (repaired) | ec65e70b |
| Edit project / driver-disposal set-remove | project detail | createDispatch (guard) | `updateDoc projects` (onUpdateProject) | – | now surfaces error (was silent) | SC | CE (repaired) | ec65e70b |
| +Add Pull (entry) | `canCreateDispatch` | createDispatch | opens AddPullModal | – | – | SC | CE (repaired: entry gated) | ec65e70b; submit BLOCKED (AddPullModal) |
| Tabs / toolbar / search / sort / well-select / disposal-select | always | – | local state | – | – | LOCAL/READ-ONLY | – |

## `/billing` (src/app/billing/page.tsx)
| Control | Render cond | Capability | Handler→Target | Payload | Busy | Success/Failure | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|---|
| Sub-tabs, company/period picker, Refresh, filters, expandable rows | always | – | local / fetchBillingData (read) | – | disabled while loading | error banner | LOCAL/READ-ONLY | – |
| DOE Region select | fuel tab | editBilling (disabled + guard) | `updateCompanyFields{doeRegion}` | `{doeRegion}` | – | error surfaced | CE (repaired) | prior; rules-lane |
| Save Price | fuel tab | editBilling (disabled + guard) | `saveDieselPrice`→`diesel_prices` + `companies.currentDieselPrice` | price+date+source | `savingPrice` | error surfaced | CE (repaired) | 6496a002 |
| Delete price (×) | `canEditBilling` | editBilling (guard) | `deleteDieselPrice`→deleteDoc | id | confirm | try/catch → error | CE (repaired) | 6496a002 |
| Backfill 12 Weeks | fuel tab | editBilling (guard) + server | `backfillDieselPrices`→`staffBackfillDieselPrices` | `{weeks:12}` | `fetchingEia` dup-guard | describeBackfillError | **BLOCKED** | staffBackfillDieselPrices not deployed |
| Fetch from EIA | fuel tab | – | `fetchEiaDieselPrice` (external EIA API read → fills form) | region | disabled while fetching | fills form / error | LOCAL/READ-ONLY (external read, no DB write) | – |
| Generate Bill | receivables | editBilling (handler guard) | `generateBillingRecord`→`billing_invoices`+`billing_counters` | summary+period | – | – | CE (repaired: guard) | 95815fc0; billing-projection + rules-lane |
| Mark Sent | receivables | editBilling (guard) | `updateBillingStatus(sent)` | id | – (idempotent) | – | CE (repaired: guard) | 95815fc0 |
| Record Payment | receivables modal | editBilling (guard) | `updateBillingStatus(paid)` | id+amount | – (idempotent) | – | CE (repaired: guard) | 95815fc0 |
| Export Generate (pdf/csv/qb/json) | export tab | – | local gen + downloadBlob + saveBillingExport (log) | – | disabled when empty | download | WORKING (local) | – |

## `/payroll` (src/app/payroll/page.tsx)
| Control | Render cond | Capability | Handler→Target | Busy | Success/Failure | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| Period/search/expand, Export All/CSV/PDF | always | – | local + fetchPayrollInvoices (read) / download | – | – | LOCAL/READ-ONLY, WORKING(local) | – |
| Add Deduction / Add Bonus | `canApprovePayroll` | approvePayroll | saveDeduction/saveAddition→`deductions`/`additions` | ded/add object | `dedSaving`/`addSaving` | error surfaced (was swallowed) | CE (repaired) | 6496a002; rules-lane |
| Remove Deduction / Remove Bonus | `canApprovePayroll` | approvePayroll (guard) | deactivateDeduction/Addition | confirm | error surfaced | CE (repaired) | 6496a002 |
| Send All / Lock Period / Send to Driver | always | – | (no handler — disabled "not yet available") | – | disabled | **BLOCKED** (feature not implemented) | 6496a002 (honestly disabled) |
| Flag row (⚐) | always | – | none | – | static | DEAD/NO-OP | 6496a002 (no longer looks clickable) |

## `/equipment` (src/app/equipment/page.tsx)
| Control | Render cond | Capability | Handler→Adapter→Target | Class | Commit/Dep |
|---|---|---|---|---|---|
| Section tabs, company picker, overview cards, row clicks, doc pager, DVIR modals | per-section `hasCapability(viewEQuipment/viewDVIR/viewEquipmentDocuments)` | view* | listEquipment/listAssignments/listDvir/getDvir/getDriverDocument (reads) | LOCAL/READ-ONLY | – |
(Equipment MUTATIONS live in the /admin Equipment tab — see EquipmentTab below.)

## `/driverlogs` (src/app/driverlogs/page.tsx)
| Control | Capability | Target | Class |
|---|---|---|---|
| Company/driver filter, date nav, expand, Truth/Compare | read (admin/it server callable for truth) | adminGetDashboardCatalog / fetchDriverShifts / fetchInvoicesForDate / getTruthDriverDaySummary (reads) | LOCAL/READ-ONLY |

## `/chat` (src/app/chat/page.tsx + src/components/chat/ChatSidebar.tsx)
| Control | Render cond | Capability | Handler→Target | Busy | Success/Failure | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| Chat surface | `canViewChat` else "Chat unavailable" | viewChat | render | – | – | (gate) | 95815fc0 |
| Send message (pane `sendInPane`; sidebar `sendMessage`) | `&& canSendChat` | sendChat (inline handler guard) | direct `addDoc chat_threads/*/messages` | – | toast / sidebar error, text restored | CE (repaired) | 95815fc0; deployed sendChatMessage is DRIVER-only → needs staff chat callable |
| New DM (`ensureDriverThread`) | gated | sendChat | `addDoc chat_threads` | – | toast on fail | CE (repaired) | 95815fc0 |
| Create group (`createGroupThread`) | gated/disabled | sendChat | `addDoc chat_threads` | – | toast | CE (repaired) | 95815fc0 |
| Archive thread | gated | sendChat | `updateDoc chat_threads{status:archived}` | – | toast | CE (repaired) | 95815fc0 |
| Broadcast toggle (sidebar + pane) | `&& canSendChat` | sendChat | `updateDoc chat_threads{broadcast}` | – | toast | CE (repaired) | 95815fc0 |
| Group member add/remove | `&& canSendChat` | sendChat | `updateDoc chat_threads` participants | – | toast | CE (repaired) | 95815fc0 |
| Monitor profile CRUD (create/type/slots/layout/lock/delete) | `&& canManageProfiles` | manageCompany | `addDoc/updateDoc/deleteDoc chat_monitors` | – | toast | CE (repaired) | 95815fc0 |
| Filters, driver search, profile stack, read-receipt write | always | – | local / localStorage / lastRead auto-write | – | – | LOCAL/READ-ONLY | – |

## `/safety` + `/safety/spills/detail`
| Control | Render cond | Capability | Target | Class | Dep |
|---|---|---|---|---|---|
| List/detail load, filter buttons, Retry | `viewSafety` | viewSafety | listSpillIncidents / getSpillIncident (reads) | WORKING (read) | – |
| Acknowledge / Assign owner / Add note / Resolve / Close / Reopen | `manageSafety` + callable-deployed (all disabled) | manageSafety | acknowledge/assign/addNote/resolve/close/reopenSpillIncident | **BLOCKED** | all 6 callables not deployed (fail-safe: disabled, no fake success) |

## `/settings` (src/app/settings/page.tsx + src/components/settings/*)
Page gate: `viewSettings`. Every config card gates edit by the noted capability; all write `updateCompanyFields`→`companies/{id}` (direct) unless noted.
| Card / control | Capability (canEdit) | Target | Busy | Failure UI | Class | Commit/Dep |
|---|---|---|---|---|---|---|
| OperationsCard (toggles/pickers) | manageCompany | updateCompanyFields via companySettingsCore builders | saving key | error banner | CE (repaired) | Phase 3; RT (companySettingsControls) |
| PhotosCard (require/min/retention) | manageCompany | updateCompanyFields (builders) | saving key | error banner | CE (repaired) | Phase 3; RT |
| RequiredPhotoSpecs (child) | manageCompany (from PhotosCard) | `photo_requirements/{cid}` setDoc + Storage + suggestPhotoCriteria | – | alert/error | CE (repaired) | ec65e70b |
| CompanyProfileCard, PackagesCard, CustomJobTypesCard, InvoiceConfigCard, LevelReportsCard, OilCompaniesCard, RateSheetsCard, TicketTemplateCard, PayConfigCard, PayrollTemplateCard, BrandingCard, JsaCard | manageCompany | updateCompanyFields (respective fields) | per-card | error banner (all previously swallowed) | CE (repaired) | ec65e70b; rules-lane / adminUpdateCompanySafe |
| PayrollTemplateCard | manageCompany | updateCompanyFields{payConfig.payrollTemplate} | fixed missing try/catch/finally | error + always clears saving | CE (repaired) | ec65e70b |
| BillingConfigCard | editBilling | updateCompanyFields{billingConfig} | – | error banner | CE (repaired) | ec65e70b |
| SWDDirectoryCard | manageCompany | `companies/{id}/swd_directory` setDoc/addDoc/deleteDoc (rules read,write:true) | – | error banner | CE (repaired) | ec65e70b; worst rules exposure |
| SpillNotificationCard | manageSafety | `updateSpillNotificationPolicy` | saving | error (honest) | **BLOCKED** | callable not deployed |
| WorkPeriodCard | verified WB-admin | `adminSetCompanyWorkPeriodConfiguration` (governed) | busy | error | **WORKING** (reference governed pattern) | – |
| RolesCard | manageRolesAndCapabilities | updateCompanyFields{roleLabels/roleCapabilities} | – | error | CE | prior; rules-lane |
| JobTypeRnDCard: Seed Test Data | isPlatformAdmin + confirm() | `job_type_usage` write | `seeding` | error banner (was silent smell) | CE (repaired: gated+confirm) | 95815fc0 |
| JobTypeRnDCard: promote/prune | isPlatformAdmin | `job_packages` updateDoc/deleteDoc | – | – | CE | rules-lane |
| Company picker | – | loadAllCompanies (read) | – | – | LOCAL/READ-ONLY | – |

## `/admin` (src/app/admin/page.tsx + src/components/admin/*)
Page gate: role admin/it. Wells/Routes/GPS tabs additionally require `canViewGlobalWellPool`.
| Control | Render cond | Capability | Handler→Target | Busy | Failure UI | Class | Commit/Dep |
|---|---|---|---|---|---|---|---|
| Add Well | manageWells gate | manageWells (server: staffWriteWellConfig) | handleAddWell→`staffCreateWellConfig`→`staffWriteWellConfig{op:create}` | isAddingWell | error | **WORKING** | prior; SC no-fallback |
| Save Changes (edit, no rename) | manageWells | (server) | handleUpdateWell→`staffUpdateWellConfig{op:update}` | isUpdatingWell | error | **BLOCKED** | deployed staffWriteWellConfig is create-only; functions source HAS op:update = deploy-lag |
| Save Changes (rename branch) | manageWells (guard) | – | direct RTDB set/remove/update well_config+packets+performance | isRenaming | error surfaced | CE (repaired: gate+busy+error) | 95815fc0; needs governed rename callable |
| Delete Well (unassign/permanent) | manageWells (gate+guard) | – | direct RTDB deletes | isDeletingWell | try/catch → showMessage (was silent) | CE (repaired) | 95815fc0; needs governed delete callable |
| Add Route | – | – | local-only (`showMessage` "staged") | – | honest message | **BLOCKED** | no governed standalone route-create; a route persists only when a well is assigned to it |
| Rename Route | manageRoutes (guard) | – | direct RTDB update well_config/*/route | isRenamingRoute | error | CE (repaired) | 95815fc0 |
| Delete Route | manageRoutes (gate+guard) | – | direct RTDB deletes | isDeletingRoute | try/catch → showMessage (was silent) | CE (repaired) | 95815fc0 |
| NDIC link/unlink, operator/well search, tank calc, filters | – | – | local + reference reads | – | – | LOCAL/READ-ONLY | – |
| Tab buttons | Wells/Routes/GPS need canViewGlobalWellPool; Plans/Audit need verified session | – | setActiveTab | – | – | WORKING | – |

### GpsRoutesTab (src/components/admin/GpsRoutesTab.tsx)
| Control | Capability | Target | Busy | Failure UI | Class | Commit/Dep |
|---|---|---|---|---|---|---|
| Record/Stop toggle | manageRoutes (gate+guard) | direct RTDB well_config/*/routeRecording | togglingWell | try/catch → padMessage (was silent) | CE (repaired) | 95815fc0 |
| Auto-add / Find Pad Wells / add custom destination | manageRoutes (guard) | direct RTDB well_config | addingWell/padSearchingWell | try/catch → message | CE (repaired) | 95815fc0 |
| Filter chips, +Add Destination, search | – | local | – | – | LOCAL/READ-ONLY | – |

### RouteManager (via GPS)
| Control | Capability | Target | Class |
|---|---|---|---|
| View/Edit/Copy/Remove route, Approve/Reject/Delete trip, Clear All, trim, Open in Maps | admin (client) | direct Firestore `route_overrides` setDoc/deleteDoc, `route_recordings/*/trips` deleteDoc (good busy+error) | CE |

### EquipmentTab (src/components/admin/EquipmentTab.tsx)
| Control | Capability | Target | Busy | Class | Commit/Dep |
|---|---|---|---|---|---|
| Add equipment / Save specs / Upload doc / Delete doc | manageEquipment (gate+guard) | governed `eQuipmentEquipment`/`eQuipmentDocuments`/`saveEquipmentSpecs`/`uploadVehicleDocument` | savingSpecs/uploading | **WORKING** (governed callables; client gate added) | 95815fc0 |

### CompaniesTab (src/components/admin/CompaniesTab.tsx)
| Control | Capability | Target | Class | Commit/Dep |
|---|---|---|---|---|
| Save company (WB-admin edit) | isWbAdmin | `adminUpdateCompanySafe` (governed) | **WORKING** | – |
| Delete/Archive company (configured) | routed via adminGetCompanyContractConfiguration | `adminArchiveCompany` | **WORKING** | – |
| Activate pending signup | isWbAdmin (client) | direct `setDoc companies` + RTDB `users/{uid}.role='it'` | CE | should route via deployed `adminApproveCompanyOnboarding` |
| Save company (non-WB / create), Add/Remove operator, Save rate sheet, Save pay config, Tier buttons | (admin) | direct `updateDoc companies` fields | CE | rules-lane / adminUpdateCompanySafe |
| Save branding (logo) | manageCompany (gate+guard) | **unauthenticated Storage POST** + `updateDoc companies.logoUrl` | CE (repaired: gated+error) | 95815fc0; Storage-rules + authenticated-SDK dependency |

### CompanyContractPanel (VerifiedAdminGate + server dual-gate)
| Control | Target | Class |
|---|---|---|
| Assign plan / Add-Remove override / Enforce / Disable / Save app config | `adminAssignCompanyPlan`/`adminAddEntitlementOverride`/`adminRemoveEntitlementOverride`/`adminSetCompanyContractEnforcement`/`adminSetCompanyAppConfiguration` | **WORKING** (governed, busy, confirms, honest failure) |

### DriversTab (src/components/admin/DriversTab.tsx) — IDENTITY LANE (untouched)
| Control | Target | Class | Note |
|---|---|---|---|
| Approve / Approve-with-assignments / Reject (pending) | `adminApproveDriverRegistration`/`adminRejectDriverRegistration` + RTDB fallback | CE | IDENTITY LANE — do not modify |
| Preview/Apply WB-M routes | `staffWriteDriverAssignment` (dry-run/apply) | **WORKING** (governed) | – |
| Assign to Customer (bind) | `adminBindDriverCompany` (canonical) / RTDB (legacy) | WORKING (bind) / CE (legacy) | IDENTITY LANE |
| Invite to Dashboard | `inviteEmployee` | **WORKING** (uses alert on error — cosmetic) | – |
| Toggle active / Toggle admin / Save roles / Role→driver / Assign-Remove customer / Set default package | direct RTDB drivers/approved, users | CE | IDENTITY LANE — swallowed errors on toggleDriverAdmin/removeCustomer noted, not modified |
| Create secure login | informational modal (no callable) | DEAD/NO-OP by design | IDENTITY LANE |
| "Routes (legacy)" | setMessage only | DEAD/NO-OP | – |
| "Migrate" / "Migrate All Legacy" | `false &&` render + stub | DEAD/NO-OP | – |
| Delete driver | `false && isWbAdmin && _legacy` (never renders) | LEGACY/UNREACHABLE | handler live, trigger dead |

## `/admin/diagnostics`, `/admin/truth-debug`, `/admin/truth-rag-exports`
| Route | Controls | Capability | Target | Class |
|---|---|---|---|---|
| /admin/diagnostics | filters/presets/select/copy/clear-from-view/Copy JSON/expand | viewDiagnostics + `!companyId` | `wb_diagnostics` subscribe + clipboard | LOCAL/READ-ONLY |
| /admin/truth-debug | Run shadow read; Approve/Revoke location; Add-to-SWD-ref; Deactivate SWD | viewTruthDebug + `!companyId` | getDashboardReadModelForDay/getShadowComparison/…; approveTruthLocation/revokeTruthLocationApproval/addTruthSwdReference/deactivateTruthSwdReference | **WORKING** (governed; per-row busy, error banner) |
| /admin/truth-rag-exports | Run/Rerun/Refresh/detail | viewTruthDebug + `!companyId` | exportTruthRagForDay/rerunTruthRagExportForDay/listTruthRagExports/getTruthRagExportRun | **WORKING** (governed) |

## `/login`, `/register`, `/demo`
| Route | Control | Target | Class | Note |
|---|---|---|---|---|
| /login | Sign In | `signIn` (Firebase Auth) | WORKING | identity lane (untouched) |
| /register | Create Account / show-hide pw | `registerWithEmail` | WORKING | identity lane (untouched) |
| /demo | Setup wizard / See results / Reset / add-remove location | `demoClassifyLocations` (deployed public) + local fallback | WORKING (local) | public |

## Shared: AppHeader / NotificationBell / SubHeader
| Control | Capability | Target | Class |
|---|---|---|---|
| Tabs (11) | per-tab capability/minRole/hasEQuipmentAccess | nav | WORKING |
| Admin link (+pending badge) | viewAdmin | nav + RTDB drivers/pending listener | WORKING |
| Truth Debug / RAG / Diagnostics links | `!companyId` + viewTruthDebug/viewDiagnostics | nav | WORKING |
| Sign Out | – | signOut() + nav | WORKING |
| Chat icon | – | toggles ChatSidebar | WORKING (local) |
| NotificationBell: bell/settings toggles, clear/dismiss, category/sound checkboxes | – | localStorage | LOCAL/READ-ONLY |
| Notification action link | – | markAsRead + nav | WORKING |
| SubHeader back | – | nav | WORKING |

---

## Consolidated server / rules / backend dependencies (one list — do not fix piecemeal)
1. **Rules exposure (systemic):** deployed Firestore rules permit any authenticated write to non-protected `companies/{id}`; `swd_directory`, `chat_threads`, `chat_monitors`, `diesel_prices`, `deductions`, `additions`, `projects`, `photo_requirements`, `route_overrides`, `route_recordings` are permissive/absent; repo RTDB rules globally open; Storage logo path allows unauthenticated write. **Real fix:** route company/config writes through the deployed-but-unused **`adminUpdateCompanySafe`** (and equivalent governed callables for the rest) + tighten Firestore/RTDB/Storage rules. Turns every CE row into WORKING.
2. **`staffWriteWellConfig op:update` deploy-lag** → Wells "Save Changes" BLOCKED.
3. **+Add Pull governed staff pull-ingest callable** (server-issued packetId + idempotency; createDispatch cap) — existing ingest callables are driver-only.
4. **Undeployed callables:** `updateSpillNotificationPolicy` + 6 spill-action callables; `staffBackfillDieselPrices`.
5. **Governed well/route DELETE + RENAME + GPS-recording callables** (currently direct RTDB).
6. **Staff chat-send callable** — deployed `sendChatMessage` is driver-only; dashboard chat writes `chat_threads` directly.
7. **Branding upload:** authenticated Storage SDK + closed Storage rules.
8. **Company onboarding:** route Activate-signup through deployed `adminApproveCompanyOnboarding`/`adminCreateCompanyWithJoinCode`.
9. **Identity lane** (undeployed staffHydrateCanonicalIdentity/staffRetireLegacyDriverLogin; DriversTab RTDB fallbacks) — protected, untouched.

## Classification totals (control groups)
- **WORKING:** dispatch mutation suite, pull delete/edit, photo review, Add Well, Equipment (admin), Company save/archive/contract-plan panel, truth-debug/RAG, WorkPeriod, tickets refresh, demo, auth, nav — plus all read/nav/local controls.
- **UI CONTAINED / SERVER EXPOSED (repaired this audit):** all settings config cards, chat, billing price/projection, payroll money, dispatch Projects/chat/disposal, admin well/route delete-rename-GPS, branding, RouteManager, Companies direct writes, RolesCard, JobTypeRnD.
- **BLOCKED:** +Add Pull submit, Wells Save Changes, Spill policy + 6 spill actions, Diesel backfill, Add Route, Payroll Send-All/Lock/Send-to-Driver, well/route delete-rename-GPS *governed* path.
- **DEAD/NO-OP:** Payroll Flag; DriversTab Routes-legacy/Migrate/Create-secure-login.
- **LEGACY/UNREACHABLE:** DriversTab Delete-driver.
