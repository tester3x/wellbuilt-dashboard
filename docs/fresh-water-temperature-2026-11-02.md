# FWD directory and Fresh Water temperature — November 2, 2026

Mike authorized importing the public ND DWR depot catalog, a Hot Water checkbox in the Dispatch builder (unchecked Cold on new jobs), and separate Hot/Cold billing metadata without changing payroll job type/rates.

The existing company-scoped getDispatchLocationCatalog returns a separate freshWaterDepots array with Developed/Satellite public projections. Existing trusted authority, demo isolation and operator scope remain intact. Depots appear with FWD badges in combined pickup/drop-off search independently of operator filtering and do not enter smart SWD defaults.

The builder carries waterTemperature through service workflow, retry identity and staff/driver create allowlists. Only hot/cold are accepted. Dashboard ticket table/detail and billing CSV/JSON exports retain explicit temperature; legacy missing fields stay unspecified. No rate table/pricing, payroll or rules changes.

Validated: 26 location/builder/temperature runtime tests; 76 Functions catalog/staff/driver authority tests; frontend and Functions TypeScript. New Fresh Water test is retained in Hosting preflight. Actual deployed staffWriteDispatch/createDriverDispatchIfAbsent source was downloaded read-only and scoped helpers/callables compared; their differences are the temperature allowlist/validation only. Deployment and live Hosting byte verification will be recorded separately.

## Mike's pickup refinement, November 2

Hot Water stays unchecked for new jobs and the builder label is simply Hot Water. The control appears only after an explicit FWD pickup selection for Fresh Water. Merely selecting the job type, typing a depot name, choosing an SWD, or choosing an FWD drop-off does not enable it. Changing pickup resets Hot and the submitted builder payload falls back to Cold, even before an effect clears stale checkbox state. Both builders enforce the same rule. The active-ticket Hot/Cold label is unchanged. This source refinement requires a new APK/Hosting release; the T301 receipt remains historical.

Mike expanded location descriptors to all search results, not only duplicated FWD names. Shared combined/catalog rows retain source-backed operator/company, county/state and legal/address/city information, with valid GPS fallback when no legal/address exists. No missing address is invented. Exact duplicated FWD names keep both source-ID rows selectable. Focused search17 tests and TypeScript pass; Hosting verification remains separately recorded.
