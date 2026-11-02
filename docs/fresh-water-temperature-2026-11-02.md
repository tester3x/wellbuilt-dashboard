# FWD directory and Fresh Water temperature — November 2, 2026

Mike authorized importing the public ND DWR depot catalog, a Hot Water checkbox in the Dispatch builder (unchecked Cold on new jobs), and separate Hot/Cold billing metadata without changing payroll job type/rates.

The existing company-scoped getDispatchLocationCatalog returns a separate freshWaterDepots array with Developed/Satellite public projections. Existing trusted authority, demo isolation and operator scope remain intact. Depots appear with FWD badges in combined pickup/drop-off search independently of operator filtering and do not enter smart SWD defaults.

The builder carries waterTemperature through service workflow, retry identity and staff/driver create allowlists. Only hot/cold are accepted. Dashboard ticket table/detail and billing CSV/JSON exports retain explicit temperature; legacy missing fields stay unspecified. No rate table/pricing, payroll or rules changes.

Validated: 26 location/builder/temperature runtime tests; 76 Functions catalog/staff/driver authority tests; frontend and Functions TypeScript. New Fresh Water test is retained in Hosting preflight. Actual deployed staffWriteDispatch/createDriverDispatchIfAbsent source was downloaded read-only and scoped helpers/callables compared; their differences are the temperature allowlist/validation only. Deployment and live Hosting byte verification will be recorded separately.
