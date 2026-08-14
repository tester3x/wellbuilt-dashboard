# WB-JSA governed callables (held)

The return URI is not proof, launch hints are not authority, and cached
or historical state is never a workflow selector.

## The required client sequence

1. Authenticate (SSO exchange for the `wellbuilt-jsa` audience, or the
   persisted secure session).
2. Call `jsaGetReadRequest({ requestId })` with the requestId from the
   parsed governed launch. Select the Read/Acknowledge workflow SOLELY
   from the returned registered `intent` — never from launch hints,
   cached state, history, or the device date.
3. Perform every stage the intent requires.
4. Submit exactly ONE satisfying terminal action through
   `jsaCompleteReadRequest` (table below).
5. Return to WB-T (`jsa-return` link) only after a successful or
   idempotently `reused:true` completion.
6. On refusal at any step (policy tightening, expiry, mismatch,
   unavailability): stay fail-closed, show accurate "return to WB Tickets
   and relaunch" guidance, and submit nothing.

## jsaGetReadRequest — authoritative workflow context

Authenticated callable; session must be `kind:'driver'`, `app:'jsa'`.
Request body, exact keys: `{ requestId: string }` (43-char base64url).

Repeatable and SIDE-EFFECT FREE — safe across process death, background,
and resume; call it as many times as recovery needs. The server re-runs
the canonical JSA access decision (contract, plan, company
configuration, shift authority) before answering, and requires the
CURRENT authority context to agree exactly with the one frozen at
registration.

Success:

```
{
  requestId: string,
  state: 'pending' | 'completed',
  intent: 'read' | 'acknowledge' | 'read_and_acknowledge',
  jobRef: string,
  groupRef: string | null,
  expiresAtMs?: number,   // pending only — UI countdown, never authority
  action?: <terminal action>  // completed only — supports safe resume
  wellName?: string,      // pending read-stage only — invoices/{jobRef}.wellName
  jobType?: string        // pending read-stage only — invoices/{jobRef}.commodityType
}
```

`wellName` / `jobType` are server-resolved invoice display fields. They
are attached ONLY after authentication, request-state, expiry, audience,
driver, company, and shift binding have already accepted, and ONLY for a
pending `read` or `read_and_acknowledge` request. The server Admin-reads
`invoices/{jobRef}` and requires the invoice's company and driver
identifiers to match the authenticated principal. Missing invoice, empty
well, or a foreign/unverifiable binding refuse `not_found` — the same
coarse class — so a foreign document's existence is not leaked.

Acknowledge-only and completed views do not carry invoice display
fields. Launch `wellName` / `jobType` hints are never authority.

NOTHING ELSE is returned: no driverId, companyId, periodId,
originLocalDate, customer, pricing, ticket, notes, pusher, credentials,
tokens, or PKCE material. A COMPLETED request reads back safely (state +
its terminal action) so a relaunched client can show "already completed"
and return, instead of re-running stages or guessing.

Refusals (coarse code → meaning):

- `unauthenticated` — no session.
- `permission-denied` → `wrong_audience` / `not_a_driver` (session),
  `binding_mismatch` (foreign driver/company, or the current authority
  context no longer matches registration — shift opened/closed/changed
  period, policy flag drifted in EITHER direction),
  `active_shift_required` / `jsa_disabled` / `authority_unverifiable`
  (the canonical access decision refuses under CURRENT policy).
- `invalid-argument` — malformed / identity-bearing body.
- `failed-precondition` → `not_found` (unregistered), `expired`.

If launch metadata disagrees with the server request (different job than
the hint suggested), the SERVER's `jobRef`/`groupRef` are the truth —
render from the response, never from the URI.

## jsaCompleteReadRequest — terminal completion

## Callable

`jsaCompleteReadRequest`

Authenticated Firebase callable. Session must be the **WB-JSA** SSO
audience (`request.auth.token.app === 'jsa'`), kind `driver`.

## Request body (exact keys)

```
{
  requestId: string,   // 43-char base64url, same id WB-T registered
  action: 'read_completed' | 'acknowledged' | 'read_and_acknowledged'
}
```

Forbidden: driverId, companyId, shiftId, periodId, hash, name, tokens,
jobRef, groupRef, legalName, signature. Extra keys are rejected.

## Terminal-action table (authoritative)

`action` is TERMINAL EVIDENCE of what actually occurred — not a UI event:

| registered intent      | satisfying action(s)                     |
|------------------------|------------------------------------------|
| `read`                 | `read_completed`, `read_and_acknowledged` |
| `acknowledge`          | `acknowledged`, `read_and_acknowledged`   |
| `read_and_acknowledge` | `read_and_acknowledged` ONLY              |

Monotone, never downgrading: stronger evidence satisfies a weaker
registered intent; neither `read_completed` nor `acknowledged` alone may
ever satisfy `read_and_acknowledge`.

## WB-JSA call point — exact

Call `jsaCompleteReadRequest` exactly ONCE per request, at the moment the
LAST required stage finishes:

- intent `read` — after the driver finishes the full first read:
  `{ requestId, action: 'read_completed' }`.
- intent `acknowledge` — after the driver's acknowledgment tap:
  `{ requestId, action: 'acknowledged' }`.
- intent `read_and_acknowledge` — after BOTH stages are true. If the UI
  runs read then a separate acknowledge step, call only after the second
  stage. If one final interaction covers both (e.g. an "I have read and
  acknowledge" confirmation at the end of the full read), that single
  interaction submits `{ requestId, action: 'read_and_acknowledged' }`.
  NEVER submit `read_completed` first "to save progress" — a partial
  stage is client UI state, not terminal evidence, and the server will
  refuse it (`failed-precondition`, `action_not_permitted`).

## Success

```
{ requestId, action, reused: boolean }
```

`reused: true` means the byte-identical terminal completion already
existed (idempotent retry / process death). A retry with a DIFFERENT
action is refused (`conflict`) — terminal evidence is immutable; a
stronger interaction belongs to a fresh request.

## Failures (coarse)

`unauthenticated` | `permission-denied` | `invalid-argument` |
`failed-precondition`

Do not invent a client Firestore write. Do not treat
`wellbuilt-tickets://jsa-return` as completion.

## Register (WB-T only)

`jsaRegisterReadRequest` `{ requestId, jobRef, groupRef?, intent }`
`intent`: `read` | `acknowledge` | `read_and_acknowledge`

## Consume (WB-T only)

`jsaConsumeReadResult` `{ requestId }`
Returns the terminal view or fails closed. Second consume sets
`alreadyConsumed: true` so the job action advances once.

## jsaPersistGovernedArtifact — immutable completed snapshot

Authenticated callable; session must be `kind:'driver'`, `app:'jsa'`.
Request body, exact keys:

```
{
  requestId: string,   // 43-char base64url
  snapshot: {          // bounded driver-authored content ONLY
    prepared?, locationAcks?, locations?,
    stepsAcknowledged?, stepAcks?,
    ppeSelected?, ppeOtherItems?,
    notes?, pusher?, otherInfo?,
    printedName,                 // required
    signature: { mimeType?: 'image/png', data: string },
    truckNumber?,                // display only
    formDate?                    // YYYY-MM-DD display only
  }
}
```

Forbidden at every layer: uid, driverId, companyId, jobRef, groupRef,
periodId, shiftId, originLocalDate, shiftState, wellName, jobType,
intent, action, completedAtMs, names/tokens/hashes. Extra keys are
rejected. Display fields never become identity or job/shift authority.

The server:

1. Loads `jsa_governed_requests/{requestId}` and requires terminal
   completion plus request-bound driver/company matching the caller.
2. Derives company, driver, job, group, period, shift, intent, action,
   and completedAtMs only from that record.
3. Admin-reads `invoices/{jobRef}` and re-verifies company/driver/job
   before write. `wellName` / optional `jobType` are invoice-derived.
4. Decodes a PNG signature, enforces a 128 KiB decoded limit, computes
   SHA-256, and writes a create-only Storage object at
   `jsa_governed_artifacts/{requestId}/signature/v1-{sha256}.png`.
5. Creates exactly one Admin-owned document
   `jsa_governed_artifacts/{requestId}`. Never writes `jsas`.

Success:

```
{
  requestId, reused, schemaVersion,
  snapshotHash, artifactWrittenAtMs,
  signature: { mimeType, byteSize, sha256, storagePath }
}
```

`reused: true` is the byte-identical retry. A retry with a different
authored snapshot or signature is `conflict`. Concurrent first writes
serialize to one document. There is no update path.
