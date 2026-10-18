# Water order planner — 2026-10-18

Source lane: release/dashboard-compact-identity-20261015, laptop checkpoint based on 78605fd8.

Dispatch Job Builder has a Water Orders tab. Plan Supply uses tank safe-fill targets (capacity minus buffer), water already present, company-scoped wells and drivers, WB M's shared level projection, existing dispatch commitments, capped daily production, truck capacity, available working hours, travel estimates and an order deadline. Unknown geometry/baselines are excluded. Dispatch can override each well's turnaround and exclude sources unsuitable for the order. Coordinate-based times are explicitly approximate.

Dispatch saves the order and frozen trip records inside a company-owned projects document first, then uses the existing governed staffCreateDispatch writer with deterministic trip IDs. Successful jobs are retained on partial failure; retries use the same birth identity. Live company/permission checks remain in the wrapper and callable. No new dispatch authority fields or rule changes. No automatic external messages.

Only currently ready trips are released. Later trips for a truck wait for its earlier trip to finish. Future pickups remain in the saved order: dispatch reopens it and clicks Dispatch to release them. There is no unattended scheduler in this version. Expired orders do not release new jobs. Current source availability is checked again before release, including earlier successful releases in the same click. Delivered totals use closed invoices linked to the project and dispatch, deduplicated by dispatch ID.

Validation: planner cases cover buffers, existing stock, partial loads, nearer supply, shared inventory, daily refill, work windows, deadlines, stable IDs, commitments, down/unknown wells and invalid inputs. Relevant identity/authority/control suites: 72 passed, 1 existing skipped, no failures. TypeScript and production Next build passed before final formatting; repeat at the preserved checkpoint.

Dashboard Hosting is not deployed in this work session; desktop release ownership remains in place. No customer orders or driver shifts were created or modified for testing. Pre-existing untracked app.json is excluded from this checkpoint.
