# `driver_shifts` event semantics — historical vs. server-authored

Two generations of events now share the same `events` array. Anything reading
that array must know which it is looking at, because they carry different
guarantees. This file states those guarantees.

## Document identity

`driver_shifts/{driverId}_{YYYY-MM-DD}`.

**Historically** this was one document per driver per local calendar day, and
a cross-midnight shift touched two of them.

**For server-authored events it is now one document per PERIOD**, named by the
period's origin day. All of a period's lifecycle — `login`, `depart_return`,
`logout` — plus `currentShiftId` and `odometerMiles` land on that one
document, however long the shift runs.

### Why: there is no timezone to file by

Filing an event on "the day it happened" needs the driver's local calendar
date at that instant. The server does not have it:

* `explicit_shift` stores **no** timezone. That is deliberate — it has no
  schedule, so it needs none, and `isWorkPeriodConfigurationComplete` returns
  complete without one. Liquid Gold's live configuration is exactly
  `{mode: 'explicit_shift'}`.
* The contracts package ships `localDateInZone`, but nothing authoritative to
  feed it.
* Company address is not a substitute. Liquid Gold is `state: 'ND'`, and
  **North Dakota spans Central and Mountain time** — the inference is wrong on
  its face. A driver working temporarily in another zone breaks any
  company-level zone anyway.
* `companies/{id}.midnightCutoff` exists but is an unused boolean, not a
  timezone.

An earlier revision used `serverIsoNow.slice(0, 10)` — the **UTC** date. Mike's
20:37 America/Chicago close is 01:37 the next UTC day, so evening closes were
filed a day late, recreating the very cross-midnight inconsistency the
authority record exists to remove.

**The origin day needs no timezone.** It is decided once, at claim, from the
device's own local calendar; validated for internal consistency
(`originDayOf(periodId) === originLocalDate`) and physical plausibility
(`isPlausibleLocalDate`, ±1 day from the server's UTC date, which covers every
real offset from UTC-12 to UTC+14); then frozen in the authority record. Every
later event reads that stored value. There is no clock-to-date step left to
get wrong.

### Consequence for readers, stated plainly

A cross-midnight period's events appear under its **origin** day, not the day
you might be looking at. `driver_shifts/{driver}_2026-08-09` will contain no
lifecycle events for a shift that began on 2026-08-08.

* **WB-JSA is already aligned** — `shiftStaleness.ts` and
  `requestPeriodBinding.ts` read the origin-day document and key on
  `currentShiftId`.
* **`daySummary` adjacency still works** — the paired events
  (`depart_return → logout`) stay adjacent in the same array, so its
  positional pairing is unaffected. What changes is *which day* shows them.
* A day-scoped view of a cross-midnight shift must fetch by the period's
  origin day (or by `shiftId`), not by today's date.

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
