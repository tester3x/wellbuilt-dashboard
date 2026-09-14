# Dashboard Level‑to‑Chat Delivery Forensic — 2026‑09‑13 (Phase 1, READ‑ONLY)

**Question:** why have automated well‑level chat messages apparently not reached chat since ~May 2026?
**Constraints honored:** no chat sends, no settings toggles, no record edits, no code edits, no Functions/Hosting/rules deploy, no event replay. Production inspected only through authorized read‑only paths. Contents/users/tokens sanitized.
**Excluded lanes (not entered):** `upsertDriverInvoice`, `invoiceOps.ts`, `photo_patch`, `patchDriverInvoicePhotos`, WB‑T outbox/photo delivery, DDJD lifecycle/job‑card visibility, WB‑JSA.

**Active audit checkpoint:** worktree `D:/dev/_dash-level-chat-audit-20260913`, branch `audit/dashboard-level-chat-forensic-20260913`, HEAD `f24d2601` (the Dashboard working tree whose `functions/src` was read; all file:line refs below are against this tree). NOTE: this is the analysis checkout, **not** an assertion that `f24d2601` is what is deployed — deployed Functions are a separate lineage (see §5).

---

## 1. Exact pipeline map (level event → rendered chat)

| # | Stage | Where (file:line) | What happens |
|---|---|---|---|
| 1 | Successful pull/level event | WB‑M/WB‑T pull → RTDB `packets/incoming/{id}` (via `ingestWbmPull`/`ingestDriverPacket` callable **or** direct) | packet carries `driverId`, `wellName`, `tankLevelFeet`, `bblsTaken` |
| 2 | Pull processor (trigger) | **`processIncomingPull`** `functions/src/index.ts:893` — v1 RTDB `ref.create` on `packets/incoming` (**DEPLOYED**, v1 nodejs20) | computes tankAfter, writes processed/outgoing, then **awaits** the chat send |
| 3 | Level‑report generator | **`sendLevelToChat(data, packetId, {tankAfterInches,tanks})`** called (awaited) `index.ts:1543` → defined `index.ts:3157` | fire‑and‑forget originally; now awaited (comment `:1540` "1st‑gen CFs can kill fire‑and‑forget") |
| 4 | **Company enablement gate** | `index.ts:3187‑3195` | reads `companies/{companyId}.sendLevelToDispatch`; **if falsy → silent return** ("feature not enabled") |
| 5 | Recipient/channel selection | `index.ts:3262‑3283` | query `chat_threads where type=='direct' AND participants array‑contains 'driver:'+driverHash`; then filter to threads with another participant `user:*`; **empty → silent return** (`[LevelChat] No direct threads` / `No dispatch threads`) |
| 6 | Delivery + stored record | `index.ts:3287‑3316` | per thread: `batch.set(messages/{auto}, {type:'level_report', text, senderId:'driver:'+hash, clientId:'level_…'})` + thread `lastMessage`/`updatedAt`; `console.log('[LevelChat] Sent … to N thread(s)')` |
| 7 | Client subscription/read | `src/app/chat/page.tsx:594` (`where('type','==','direct')`) + messages subcollection listener | dashboard user subscribes to direct threads + messages |
| 8 | Rendering + unread/badge | `src/app/chat/page.tsx:1519` `isLevelReport = msg.type==='level_report'` → renders a "Level Report" block (`:1539`); unread via `isThreadUnread` + `lastMessage.senderId !== myParticipantId` (`:1143`) | **level_report IS rendered and badges** — not hidden by type |
| 9 | Retry / failure / audit | none | per‑thread try/catch logs only (`:3311`); `sendLevelToChat` wrapped in try/catch, **non‑blocking, no retry, no durable audit** (`:3317`). A silent skip at stage 4 or 5 leaves only a `console.log` — no stored trace. |

**Config write path (settings):** `LevelReportsCard.tsx` toggle → `updateCompanyFields(companyId,{sendLevelToDispatch})` → **direct client `updateDoc(companies/{id})`** (`src/lib/companySettings.ts:551`) — NOT a governed callable, so it is subject to the deployed Firestore rules on `companies`.

**Auto‑threading (note):** `createOrFindDispatchThread` (`index.ts:3752`, DEPLOYED callable) and `onUserWrite` (DEPLOYED v1 RTDB trigger) were the original auto‑threading mechanism (4/23). `createOrFindDispatchThread` has **no client callers** in `src/` — the current client creates direct threads itself (`chat/page.tsx:608`). *(Driver‑participant pid form under investigation — §3.)*

---

## 2. Settings matrix

| Setting | Field | Default | Written by | Gate effect |
|---|---|---|---|---|
| Company: send level to dispatch chat | `companies/{id}.sendLevelToDispatch` | **falsy/unset** (off unless toggled) | client `updateDoc` via `LevelReportsCard` (`companySettings.ts:551`) | **Stage‑4 hard gate** — off ⇒ nothing generated (silent) |
| Company: level template | `companies/{id}.levelReportTemplate` | default template literal (`index.ts:3198`) | client `updateDoc` | cosmetic only |
| Per‑user chat notifications | *(see §3 — client notification/badge settings `src/lib/notifications.ts`, `NotificationBell.tsx`)* | — | — | affects UI badge, not generation |

**Firestore‑rules dependency:** because the toggle is a direct client write to `companies/{id}`, a rules cutover that denies dashboard‑user writes to `companies` would make the toggle **appear to do nothing** (write rejected) while the stored value stays whatever it last was. (Deployed rules not asserted here — see §7 unknowns.)

---

## 3. Driver‑pid match — the identity‑form mismatch (CONFIRMED from source)

`sendLevelToChat` keys everything off the **pull packet's `driverId`**:
- pre‑gate: `db.ref('drivers/approved/'+data.driverId)` — if absent → `[LevelChat] Driver not found in approved` + return (`index.ts:3173‑3176`); if present but no `companyId` → `[LevelChat] No companyId on driver` + return (`:3180`).
- channel match: `driverPid = 'driver:'+data.driverId`; Firestore `chat_threads where type=='direct' AND participants array‑contains driverPid` (`:3263‑3267`).

**Both direct‑thread creators build the driver participant as the LEGACY `drivers/approved` hash:**
- Dashboard client `ensureDriverThread` (`src/app/chat/page.tsx:590,612`): `driver:${driverHash}` where `driverHash` = a `catalog.approved` (RTDB `drivers/approved/{hash}`) key; `user:${uid}` for the dispatcher.
- WB‑T‑invoked `createOrFindDispatchThread` (`functions/src/index.ts:3768‑3773,3834`): also `driver:${driverHash}` verified against `drivers/approved/{hash}`.

**But the secure pull‑ingest stamps the CANONICAL id:** `ingestWbmPull.ts:81‑90` writes the outgoing packet with `driverId: driver.driverId` where `driver = requireSecureDriver(request,{allowLegacyHash:false})` → `driverId = auth.token.driverId` (canonical id validated against **`drivers/profiles/{driverId}`**, a *different keyspace* from `drivers/approved`) (`functions/src/security/requireDriverAuth.ts:26‑47`).

⇒ **CONFIRMED break for any driver on the secure/canonical plane:** `packet.driverId = canonicalId` →
1. `drivers/approved/${canonicalId}` does not exist → `sendLevelToChat` returns at `index.ts:3175` (`Driver not found in approved`); and
2. even past that, `driver:${canonicalId}` can never match threads carrying `driver:${legacyHash}`.
`sendLevelToChat` does **no** approved↔profiles reverse‑mapping and never queries `drivers/profiles`. Its own code is **unchanged since 2026‑04‑11** — what changed is the *content* of `packet.driverId`.

**Three distinct silent‑skip branches therefore exist** (all end in a `console.log` + `return`, no stored trace, no retry):
| Branch | Log line (index.ts) | Cause |
|---|---|---|
| `:3175` | `Driver not found in approved` | packet carries a **canonical** driverId (secure ingest) — systemic real‑driver case |
| `:3180` | `No companyId on driver` | approved record exists but lacks `companyId` — **observed live for Gabriel 3/7 (likely DDJD test drivers)** |
| `:3281` | `No dispatch threads` | the driver's direct thread lost its last `user:` participant (capability fan‑out, §6 Candidate A) |
| `:3193` | *(none — silent return)* | company `sendLevelToDispatch` off (config) |

## 4. Failure classification (the six required questions)

### CONFIRMED failure point (production Cloud Logging, read‑only via `firebase functions:log --only processIncomingPull`)
Recent window (2026‑09‑13) shows the generator runs and **skips at the companyId gate**:
```
processIncomingPull: Processed Gabriel 7: … -> response_…
processIncomingPull: [LevelChat] No companyId on driver, skipping
processIncomingPull: Processed Gabriel 3: … -> response_…
processIncomingPull: [LevelChat] No companyId on driver, skipping
```
Outcome tally in the sampled window: **2× `[LevelChat] No companyId on driver, skipping`, 0× `Sent`.** This is the branch at **`index.ts:3180`**: `sendLevelToChat` reads RTDB `drivers/approved/{data.driverId}`, the record **exists** (passes the `:3174` not‑found check) but has **no `companyId`**, so it returns **before** the `sendLevelToDispatch` config gate (`:3193`) is ever evaluated.

⇒ **CONFIRMED: level reports are GENERATED but SKIPPED at generation** — not disabled by the `sendLevelToDispatch` config (that gate isn't reached), not rejected, not stored‑then‑hidden. The block is that the pulling driver's `drivers/approved/{driverId}` record carries no `companyId`.

**Caveats (honest):** (a) the CLI log window is small (~35 lines, only 2026‑09‑13) — it proves the *current* outcome, not the May transition; (b) the sampled pulls are **Gabriel 3/7**, which may be **DDJD test drivers** whose approved‑driver records legitimately lack `companyId` — so this sample may not represent a real Liquid Gold driver's pull. Whether *real* driver pulls also stop here (vs at the `sendLevelToDispatch` gate or deliver) needs a wider log window or a read of a real `drivers/approved/{hash}` record. The mechanism (early `companyId` skip) is confirmed; its population across real drivers is the open item.

### Answers
- **Are level‑chat messages disabled by configuration?** Not the observed cause — the `sendLevelToDispatch` gate (`:3193`) is **never reached** in the sampled pulls (they return earlier at `:3180`). Config remains an *independent* possible gate for real drivers; needs the `companies/{cid}.sendLevelToDispatch` value to rule in/out.
- **Are messages never generated?** They **are** generated (processIncomingPull runs, `sendLevelToChat` is invoked) — but they **self‑abort inside the generator** at an identity gate before writing. So "generated‑but‑skipped," not "never invoked."
- **Generated but rejected?** No — delivery writes are Admin‑SDK batches that bypass rules; there is no rejection path. The abort is a client‑of‑its‑own precondition, not a server rejection.
- **Stored but not delivered/read?** No evidence of stored‑then‑undelivered; the abort happens before any `messages` write.
- **Delivered but hidden by UI/filter/capability?** No — `level_report` is rendered and badged (`chat/page.tsx:1519,1539`); not hidden by message type. (A capability change can instead *remove the recipient thread*, branch `:3281` — that's a generation‑side skip, not a UI hide.)
- **Most recent confirmed success / what changed:** last success = newest `type:'level_report'` message or newest `[LevelChat] Sent…` log line (needs prod read/Cloud Logging). What changed: see §6.
- **Disabled by configuration?** Possible and the first gate — `sendLevelToDispatch` is off by default and is a hard silent gate (`index.ts:3193`). Needs the current Liquid Gold `companies` doc value (prod read) to confirm.
- **Never generated?** Only if config off OR the deployed `processIncomingPull` predates/omits the 4/11 `sendLevelToChat` wiring (deploy‑lineage risk, §5).
- **Generated but rejected?** No server rejection path — writes are Admin‑SDK batch (bypass rules). Not applicable at delivery.
- **Stored but not delivered/read?** If written to a direct thread, the client subscribes and renders it. Unlikely unless the thread isn't one the dashboard user subscribes to.
- **Delivered but hidden by UI/filter/capability?** `level_report` **is** rendered and badged (`chat/page.tsx:1519,1539`). Not hidden by message type. (Thread‑type filter shows `direct` — the target type.)
- **Most recent confirmed success / what changed:** requires Cloud Logging + a chat_threads scan — see §6/§7.

## 5. Deployed vs source lineage
- **Deployed (confirmed present)** in project `wellbuilt-sync`: `processIncomingPull` (v1 db ref.create), `createOrFindDispatchThread` (v2 callable), `sendChatMessage` (v2 callable), `onUserWrite` (v1 db ref.write), `onShiftCreate/onShiftUpdate` (v1), `ingestWbmPull`/`ingestDriverPacket` (v2). Source `functions/src/index.ts` currently wires `sendLevelToChat` into `processIncomingPull` unconditionally.
- **NOT verifiable via `firebase functions:list`:** per‑function `updateTime`/revision (CLI omits it; `--json` record has `hash`/`labels`/`codebase` but no timestamp). Therefore **whether the deployed `processIncomingPull` bytes actually contain the `sendLevelToChat` call is UNCONFIRMED from here** — it must be verified via Cloud Logging (presence of any `[LevelChat]` line) or a deployed‑source/GCP revision read. `release/dashboard-final-20260913 @ 4ef9bac8` is Hosting‑only and is **not** the Functions baseline.
- **Feature source lineage (git):** WB Chat 4/07 `bc6c2846`; Chat overhaul + Level Reports setting 4/09 `c585b04f`; **Level‑to‑chat CF (`sendLevelToChat`+`sendLevelToDispatch`) 4/11 `e8b05a4c`**; `createOrFindDispatchThread`+`onUserWrite` 4/23 `5170ae52`; LOCKED Liquid‑Gold config tests 8/06‑08 `48f96d67`/`838462e2`. *(Identity/pid‑model changes in the May window — §6.)*

## 6. What changed / candidates (with honest timing)

`sendLevelToChat` itself is **unchanged since 2026‑04‑11** (`e8b05a4c`, verified `git log -S`). The break is in what feeds it.

**Candidate B — canonical‑driverId cutover (source‑CONFIRMED mechanism; timing = August, later than "~May").**
- `f70c28b4` 2026‑08‑21 "canonical‑only assignment, pull ingest, catalog profiles" introduces `ingestWbmPull.ts` (stamps `packet.driverId = canonicalId`). Earliest identity‑claims plane `710c8e9e` 2026‑07‑31.
- Effect: real drivers' pulls now carry a canonical id that `sendLevelToChat` cannot resolve in `drivers/approved` nor match against `driver:${legacyHash}` threads → branch `:3175`.
- This is the strongest, fully source‑proven cause, but its **field‑impact date depends on when the WB‑M app (`C:\WellBuiltMobile`, separate repo — LCGTP/other lane, not inspected) began routing pulls through the secure `ingestWbmPull` path.** If that rollout was earlier than the server code date suggests, or phased, it can front‑run the commit date.

**Candidate A — capability‑based dispatcher fan‑out (May‑consistent; needs prod to confirm).**
- `5170ae52` + `9c7293e1` + `251855c2` (all 2026‑04‑23) added `onUserWrite` + capability‑gated chat membership. `onUserWrite` (`index.ts:4031‑4155`) fans a `user:` participant **out** of threads when that user loses `viewChat`+`sendChat` (demotion, company reassignment, deletion, or a company `roleCapabilities` override).
- Effect: a driver's direct thread can lose its **last `user:` participant**; `sendLevelToChat` then finds "No dispatch threads" (`:3281`) and silently no‑sends — while the driver identity is still legacy/valid. This fits the "~May" symptom timing but **cannot be confirmed from source** — it depends on actual role/company mutations and thread participant state in prod.

**Observed‑live (branch `:3180`, `No companyId`)** for Gabriel 3/7 is a third, real signature — an approved‑driver record lacking `companyId` (likely DDJD test drivers; could also affect canonically‑migrated records if `companyId` isn't stamped on the `drivers/approved` key).

**Not mutually exclusive.** The user's "~May" estimate matches Candidate A's window; the hypothesized driverId‑form mechanism matches Candidate B (server‑enabled Aug). The Cloud Logging `[LevelChat]` crossover (§7 #1) is what disambiguates *which branch* began firing *when* for *real* drivers.

## 8. Smallest repair ownership split (Phase‑2, NOT done here)
- **Dashboard chat/level lane (this repo — the fix belongs here):** make `sendLevelToChat` identity‑robust — resolve the packet's `driverId` to the **legacy `drivers/approved` hash** (or add a `drivers/profiles → approved`/pid reverse‑map) before the `drivers/approved` gate and the `driver:` thread match, so canonical‑plane pulls resolve; and/or match threads by a stable canonical driver key written on both sides. Optionally emit a durable audit/metric on each skip branch (`:3175/:3180/:3281/:3193`) instead of a bare `console.log`, so future silence is observable.
- **Identity lane (owns `requireDriverAuth`/`ingestWbmPull`/`drivers/profiles` ↔ `drivers/approved`):** ensure a canonical→approved (or unified) mapping exists that chat can consume, and that `companyId` is present on whatever key chat reads. (Coordinate; do not duplicate — this may be LCGTP/identity‑owned.)
- **Config lane (Dashboard settings):** confirm `companies/{cid}.sendLevelToDispatch` is enabled and that the deployed Firestore rules permit the `LevelReportsCard` toggle write (direct `updateDoc`).
- **NOT this lane:** WB‑M app pull‑routing (`C:\WellBuiltMobile`), WB‑T outbox, DDJD/job‑card, WB‑JSA, and the excluded photo/invoice functions.

## 7. Unknowns & required evidence (read‑only, authorized)
1. **Cloud Logging** for `processIncomingPull` filtered to `"[LevelChat]"` — the fastest definitive answer. It distinguishes: no lines at all (not generated / deployed bytes lack the call) vs `feature not enabled` (config off) vs `No direct threads`/`No dispatch threads` (recipient/pid gap) vs `Sent … to N thread(s)` (delivered). **This single query classifies the failure.**
2. **`companies/{liquid-gold}` doc** (read‑only) — current `sendLevelToDispatch` value (+ history if audited).
3. **`chat_threads` scan** (read‑only) — do direct threads exist with a `driver:{…}` participant matching current pull `driverId`, and any `type:'level_report'` messages (last one = last success date).
4. **Deployed `processIncomingPull` revision/updateTime** (GCP console / gcloud) — to confirm deployed bytes include the 4/11 wiring.
5. **Firestore rules (deployed)** on `companies` — whether the settings toggle write is currently permitted.
