# WB-JSA complete callable (held)

Grok's held client must invoke this **after** the required read or
acknowledgment is actually finished. The return URI is not proof.

## Callable

`jsaCompleteReadRequest`

Authenticated Firebase callable. Session must be the **WB-JSA** SSO
audience (`request.auth.token.app === 'jsa'`), kind `driver`.

## Request body (exact keys)

```
{
  requestId: string,   // 43-char base64url, same id WB-T registered
  action: 'read' | 'acknowledged'
}
```

Forbidden: driverId, companyId, shiftId, periodId, hash, name, tokens,
jobRef, groupRef, legalName, signature. Extra keys are rejected.

`action`:

- `'read'` — first full read (required when the registered intent is
  `read` or `read_and_acknowledge`)
- `'acknowledged'` — later acknowledgment only when the registered intent
  is `acknowledge`

## Success

```
{ requestId, action, reused: boolean }
```

`reused: true` means an identical terminal completion already existed
(idempotent retry / process death).

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
