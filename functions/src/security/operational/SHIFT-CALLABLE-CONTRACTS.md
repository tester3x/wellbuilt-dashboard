# Shift callable contracts — for WB-S integration

Every callable below requires a **Firebase Auth driver session**: a token with
`kind: 'driver'` and `driverId`, minted by `authenticateDriver` and exchanged
via `signInWithCustomToken`. Unauthenticated REST — what WB-S vc22 uses today —
will not reach any of them.

**There is no `driverId` or `companyId` input on any callable.** The subject
comes from `canonicalDriverAuthority`: the token asserts *who is calling*, the
records decide *whether that driver is live and which company they belong to*.
A stale `companyId` claim is reconciled to the profile's company, not honoured.
Cross-driver access is impossible by construction rather than by check.

Every callable rejects unknown fields with `unknown_fields:<name>` rather than
ignoring them, so a typo fails loudly.

---

## `resolveActiveDriverShift`

```
request:  {}
response: { protocolVersion: 1, state: 'open',   periodId, originLocalDate }
        | { protocolVersion: 1, state: 'none' }
        | { protocolVersion: 1, state: 'unverifiable', reason }
```

**Side-effect free.** It never writes, so calling it at cold start, on resume,
or on every foreground cannot mint a shift.

`reason` ∈ `authority_absent` · `authority_uninitialized` ·
`authority_inconsistent` · `driver_mismatch`.

> **`unverifiable` means UNKNOWN, never "no shift open."** Treating it as
> `none` would let a second concurrent period be minted for every driver whose
> record predates the authority. Fail closed: surface the failure and do not
> offer Start Shift.

## `claimDriverShift`

```
request:  { periodId: 'YYYY-MM-DD_HHMMSS', originLocalDate: 'YYYY-MM-DD' }
response: { protocolVersion: 1, state: 'open', periodId, originLocalDate, claimed: boolean }
```

The device **proposes**; the server **decides**. `originLocalDate` must equal
`periodId.slice(0,10)` and must be within ±1 day of the server's UTC date.

* `claimed: true` — the proposal was taken. Exactly one authoritative `login`
  event was written, carrying `shiftId`.
* `claimed: false` — a period was **already open**. The proposal was discarded;
  `periodId`/`originLocalDate` in the response are the **existing** binding.
  **Adopt them and discard your local mint.** Two devices racing produce one
  period and both learn the same answer.

Errors: `malformed_period` · `implausible_origin_local_date` ·
`period_date_mismatch` · `authority_absent` · `authority_uninitialized` ·
`driver_mismatch`.

## `closeDriverShift`

```
request:  { periodId, odometerMiles?: integer 0..5000 }
response: { protocolVersion: 1, state: 'none', closedPeriodId, alreadyClosed: boolean }
```

One transaction writes: the authority pointer → null, the origin-day
`currentShiftId` → `''`, one authoritative `logout` with `shiftId`, and
`odometerMiles` when supplied.

`odometerMiles` is **total miles for the shift** (end − start), the value
WB-S's arrival modal already computes — not an absolute reading. Six-figure
readings are rejected, because they would otherwise become the day's
`driveMiles` in every summary.

* `alreadyClosed: true` — safe repeat delivery of the same close. **No second
  logout is appended**, and the odometer is not rewritten.
* A close naming a **different** period is refused with `period_mismatch` and
  touches nothing — a delayed retry from an old device must never end the
  shift a driver is currently working.

> **Single-slot limitation.** `lastClosedPeriodId` remembers only the most
> recent close. After a *subsequent* shift closes, a delayed retry of the
> earlier close no longer matches and is refused with `no_open_period` rather
> than answering `alreadyClosed`. That is the safe direction — no shift ends —
> but idempotency is not indefinite.

## `recordDepartReturn`

```
request:  { periodId }
response: { protocolVersion: 1, periodId, recorded: boolean }
```

Appends exactly one `depart_return` to the period's origin-day document, with
`shiftId` and a server timestamp.

* `recorded: false` — the event already existed for this period. **Idempotent
  on a repeated tap or an offline retry**; presence is matched on type *and*
  `shiftId`, so yesterday's depart_return cannot suppress today's.
* Cannot open a period (`no_open_period` when none is open), cannot close one
  (the pointer is never written), cannot reach another driver or company.
* The event type is fixed by the endpoint. There is **no** "write any event"
  callable, by design.

**Ordering is preserved, not enforced.** The server does not police
depart_return → Post-Trip → close. Keep that order in the client; the server
only guarantees attribution to the open period.

---

## Resume and stale-close semantics

These are the rules the client must implement. They are not enforceable
server-side, so getting them wrong is silent.

1. **Resume must resolve, not re-login.** On app restart with an enforced
   explicit shift, call `resolveActiveDriverShift`. If it returns `open`,
   restore that binding. **Do not call `claimDriverShift` to "re-establish"
   it** — and note that even if you did, an already-open period returns
   `claimed: false` and writes nothing, so a duplicate login is impossible.
   That is a safety net, not a licence.
2. **`autoCloseStaleShift` must not run under enforced explicit shifts.** The
   server has **no maximum shift duration**. A 23-hour period is as valid as a
   1-hour one, and a client-side staleness heuristic would close a shift the
   driver is still working. Only an explicit driver action closes a period.
3. **A login alone never claims.** Authentication and shift authority are
   separate. Signing in does not open a period.
4. **Only a successful claim writes the authoritative `login`.**
5. **Only a successful matching close writes the authoritative `logout`.**
6. **Operational events can neither mint nor close.** `recordDepartReturn`
   requires an already-open period and never touches the pointer.
7. **Stop writing lifecycle events directly.** Once integrated, WB-S must not
   append `login`/`logout`/`depart_return` or set `currentShiftId` /
   `odometerMiles` by REST. The server authors all of them now; doing both
   duplicates every event. The staged rules change enforces this — see the
   deployment gate in `firestore.rules`.
8. **Surface authority failure before the Start Shift checklist.** A driver
   must learn the shift cannot be established *before* filling anything in.

## Still outstanding

`depart_return` is now server-authored **with** `shiftId`. Historical
`depart_return` events carry none and cannot be attributed to a period — see
`SHIFT-EVENT-SEMANTICS.md`.

Whether a live WB-S driver session satisfies the canonical
credentials/profile gate is **unverified**. Legacy-hash drivers
(`driverId === passcodeHash`, no `driver_credentials` record) will fail with
`driver_not_authoritative`. Test cheaply and safely by calling
`resolveActiveDriverShift` from a real device session — it writes nothing, and
its three failure modes are diagnostic.
