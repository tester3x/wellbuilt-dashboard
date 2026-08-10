# `driver_shifts` event semantics — historical vs. server-authored

Two generations of events now share the same `events` array. Anything reading
that array must know which it is looking at, because they carry different
guarantees. This file states those guarantees.

## Document identity

`driver_shifts/{driverId}_{YYYY-MM-DD}`, one per driver per **local calendar
day**. Note: per DAY, not per shift. A shift that crosses midnight touches two
documents.

## Two generations

### Historical events (every event written before this change)

Written by WB-S `shiftTracking.ts` `recordShiftEvent`. Shape:

```
{ type, timestamp, lat, lng, source, synthetic?, displayName?, driverHash? }
```

* `type` — `login` | `logout` | `depart_return`
* `source` — `'wbt' | 'wbm' | 'wbs'` (which app produced it)
* **No `shiftId`.** This is the important one.

The event is appended to the document for the day the event **occurs** on
(`const date = dateString(now)`), never the shift's origin day.

**What you may NOT conclude from a historical event.** Which shift it belongs
to. There is no period attribution in the element, so for a cross-midnight
shift the only link between a `login` on day N and a `logout` on day N+1 is
adjacency and human judgement. Any code that infers that link is guessing.

This is exactly why the targeted retro-close migration requires a human to
supply the reviewed evidence: `decideRetroClose` verifies a stated pairing, it
never derives one.

### Server-authored events (this change onward)

Written by `claimDriverShift` / `closeDriverShift` via `buildLifecycleEvent`:

```
{ type, timestamp, shiftId, source: 'server' }
```

* `shiftId` — the period id. Makes "exactly one authoritative close for period
  X" provable instead of inferred.
* `source: 'server'` — distinguishes these from app-authored events. **This is
  the discriminator**: `source === 'server'` implies `shiftId` is present.
* `timestamp` — ISO string from the **server** clock. Not `serverTimestamp()`:
  Firestore rejects sentinels inside array elements, and the established event
  protocol is already an ISO string.
* No `lat`/`lng`. The server has no position, and inventing one would be worse
  than omitting it. Readers already treat them as optional.

Still written to the day the event **occurs** on, matching WB-S. The close
transaction therefore spans the origin-day marker and the close-day event as
separate documents — which is why it is one Firestore transaction.

## Rules for readers

1. **Never assume `shiftId` exists.** Most events in production do not have it.
2. **Never treat its absence as an error.** It means "historical", not "bad".
3. Key off `type` for existing behaviour. Every current reader already does,
   which is why adding `shiftId` is purely additive and broke nothing.
4. `daySummary.ts` pairs events by **array adjacency**, not by `shiftId`. Adding
   the field does not change its output.
5. The durable history is this array. `driver_shift_authority.lastClosedPeriodId`
   is a single slot holding only the most recent close — it is not a history and
   must never be read as one.

## Open question: should `depart_return` carry `shiftId`?

**Yes — but not from here, and it is not done.**

* For consistency it should: `depart_return` is a shift-lifecycle event, and
  today a return leg cannot be attributed to a period any more than a historical
  logout can.
* The server does not produce it. `depart_return` is authored solely by WB-S
  (`AuthContext.tsx` → `recordShiftEvent`), on GPS capture, and no server path
  writes it. The claim/close callables author `login`/`logout` only.
* Therefore this cannot be fixed on the backend. It requires a WB-S change,
  which is outside this packet's authorization and has not been made.
* Doing it would also be additive and safe: `daySummary.ts:112` pairs
  `depart_return → logout` positionally and ignores unknown fields.

**Status: recommended, not implemented. Needs a separate WB-S packet.** Until
then, `depart_return` carries no period attribution and nothing may assume it
does.
