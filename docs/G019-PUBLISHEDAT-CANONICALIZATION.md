# G-019: canonical publication timestamp

Frozen source parent: `77e73ac6bd5d33dcb7888e836621bcedeb1ddfda` (G-018R1).

## Incident and cause

The coordinator reported that a production publication on 2026-09-22 succeeded,
but the subsequent `staffWriteDispatch` revision load failed with
`non_plain_object` at `$.publishedAt`. The publisher's Firestore adapter supplied
`FieldValue.serverTimestamp()` inside the retryable transaction. Firestore
materialized that sentinel as a `Timestamp` instance. The canonical loader
requires plain data and correctly rejected that object.

The reported emergency intervention replaced the production value with
`2026-09-22T10:20:59.481Z`, after which dispatch creation succeeded. This was an
incident workaround, not the intended publication pipeline. This repair neither
reads nor rewrites that production revision or dispatch. The incident details
are coordinator-provided, not independently verified against production.

## Source repair

`functions/src/security/jobPacketPublishCallable.ts` now captures
`new Date().toISOString()` from the server process after trusted-authority
validation and before entering `runTransaction`. Each invocation has one value;
all transaction retries reuse it. The existing publication logic passes it to
the revision's `publishedAt`, receipt's `publishedAt`, and head's `updatedAt`.
The value is an ordinary UTC ISO-8601 string, not a Firestore commit-time sentinel.

An exact request replay returns its existing receipt without writes. An unchanged
publication creates its own receipt while preserving the prior revision and head.
A changed publication still allocates the next sequential revision. No hash,
plain-data validator, trusted-authority decision, effect inventory, transaction
ordering, rules, deployment manifest, or dispatch implementation changes.

The stored-revision validator currently models `publishedAt` as `unknown` and
enforces the plain-data boundary rather than a dedicated ISO-format constraint.
This repair makes the production writer emit the chosen canonical ISO string; it
does not broaden validation or add object/toMillis conversions.

## Regression evidence and limits

`jobPacketPublicationPersistence.test.ts` invokes the exported publication and
dispatch callables through their SDK `run` entrypoints. Their actual publication
adapter, trusted-authority reader, persistence logic, revision loader, validator,
binding stamp, and dispatch writer execute. Only Firebase I/O is replaced with a
transaction harness; the harness preserves SDK object prototypes, models the
server-timestamp transform using the real SDK `Timestamp`, discards a retry's
writes, and rejects reads after writes. This is an adapter integration unit test,
not a claim of Firestore-emulator or production execution.

The tests inspect the adapter's write payloads and pass its stored revision
directly to `validateStoredRevisionForBinding`, `loadVerifiedRevisionFromData`,
and the real `staffWriteDispatch` loader. There is no manually normalized revision
fixture or intermediate rewrite. A JSON round-trip is used only as an assertion.

Coverage includes primitive/plain JSON storage, immediate dispatch creation,
retry timestamp consistency, receipt replay, unchanged publication, revision 2,
strict rejection of SDK Timestamp and arbitrary toMillis objects, and caller
timestamp/trusted-authority denial. `IMPLEMENTED_EFFECT_IDS` remains empty.

With the final test fixture, restoring the exact parent callable deliberately
fails six of the eight new tests, including the original dispatch error. Moving
the repaired clock back inside the transaction deliberately fails the retry
boundary test. Restoring the repair passes all eight.

The exact parent full Jest baseline has four unrelated failures across
`adminDashboardCatalog`, `dashboardWriteInventory`, and
`dashboardReadWriteClosure`; those files are not repaired by this change. Exact
test counts, commands, exit codes, environment, and final Git provenance belong
to the external G-019 repair return. No production access or deployment is part
of this checkpoint.
