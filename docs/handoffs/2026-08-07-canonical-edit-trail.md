# Canonical Edit Badge + Cross-App Correction Trail

Local-only on `security/database-containment`. **Not deployed.**

## Product boundary (authoritative)

| App | Role | Edit age limit |
|---|---|---|
| **WB-T** | Assigned jobs + tickets | **24h ticket edit** (WB-T only; not modified here) |
| **WB-M** | Route maintenance + flow rate | **No deadline** for pull/flow corrections |
| **Dashboard** | Admin/ops | Pull corrections via CF; no WB-M-style deadline |

Once **Send** is tapped, every later correction is an edit (queued or processed, WB-M or WB-T origin).

## Shared record (WB-T → WB-M)

1. WB-T `sendWbMobileTankPacket` → `packets/incoming/{packetId}` with `originAppContext: 'wbt'`.
2. CF `processIncomingPull` → `packets/processed/{packetId}` (stable id).
3. WB-M Pull History backfills by `driverId` / `driverName`.
4. WB-M edit → `packets/incoming/edit_*` with `source: 'wbm'`.
5. CF `processEditRequest` updates the same processed row and appends `packets/editHistory/{packetId}/{eventId}` (server-written; **not rules-enforced immutable under current production rules**).

**Ticket/invoice cascade:** exact identity only; non-cancelled; **unchanged** in this packet.

## Canonical contract

- Summary: `editedAt`, `editedBy`, `editCount`, `originalSubmittedAt`
- Events: `packets/editHistory/{packetId}/{eventId}`
- Badge: `editCount>0` OR `editedAt` OR legacy markers

## Rules truth (correction gate)

### Current production / local root rules

```json
{ "rules": { ".read": true, ".write": true, ... } }
```

**RTDB rule semantics:** shallower rules override deeper ones. Child rules can only **grant additional** privileges; they **cannot revoke** a parent `.write: true`.

Therefore a nested proposal such as:

```json
"editHistory": { "$packetId": { ".write": false } }
```

**does not make `packets/editHistory` immutable** while any ancestor still has `.write: true`. Clients can still write that path today. **Do not deploy** that proposal as a security control. **Do not describe trail storage as rules-immutable** under open parent rules.

Server Admin SDK writes still work; integrity today is **trust-of-clients + operational convention**, not rules enforcement.

### Smallest secure options (report only — no expand until reviewed)

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A. Full parent-rule containment** | Replace open root `.write: true` with path-scoped rules: clients may write `packets/incoming` (or nothing if ingest is callable-only); **deny** client write on `packets/processed`, `packets/editHistory`, `packets/outgoing`, etc.; Admin/CF retain write. | True RTDB immutability for trail + processed; matches dual-run security direction. | Touches entire tree; requires dual-run migration, regression of all writers (WB-M, WB-T, Dashboard, watchdog paths). Largest blast radius. |
| **B. Server-owned storage + callable reads** | Keep trail off open RTDB (or under a path never client-writable after A). CF writes events via Admin. Clients read via **HTTPS callable** (or privileged SDK) that checks company/route/driver claims. Optional: stop client REST reads of history. | Strong integrity + can enforce tenancy at read time; smaller surface than rewriting every open path at once if combined with moving only history. | New read path for Dashboard/WB-M; offline/cache changes; still need to stop client write somewhere (parent containment or non-RTDB store). |

**Recommendation for later packet (not this one):** prefer **A for write containment** of `processed` + `editHistory` + related packets nodes, and **B for cross-tenant read filtering** if open `.read: true` remains a problem. Neither is implemented or deployed here.

## Indexes (local rules file only)

`packets/processed` `.indexOn`: `driverId`, `driverName`, `wellName`, `invoiceDocId` — still a **later rules deploy** concern; not claimed as live-enforced until deployed.

## Safety refs

- Dashboard: `safety/edit-trail-pre-rewrite` (old tip `70a1b1c`)
- WB-M: `safety/edit-trail-wbm-pre-rewrite` (old tip `298acc8`)
