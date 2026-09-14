# Watchdog / Level-to-chat `processIncomingPull` overlap — 2026-09-14

**Status:** coordination note only. **No deploy** of `processIncomingPull`.

## Owners

| Lane | Owner | What they need in `processIncomingPull` |
|---|---|---|
| WhatsApp Level Watchdog (this lane) | Watchdog | Driverless packets (`source=whatsapp_watchdog`, `driverId=null`); **reported bottom authoritative**; HMAC ingest writes `packets/incoming` then this trigger runs. |
| Level-to-chat | Claude (`audit/dashboard-level-chat-forensic-20260913` @ `7ccac336`) | `sendLevelToChat` after canonical writes; current prod skip is `[LevelChat] No companyId on driver` / canonical vs `drivers/approved` pid mismatch. |

Both lanes share **one** deployed v1 function (`processIncomingPull`, hash `059134ca…` as of 2026-09-13 list). Independently deploying Watchdog’s `d3c2d452` hunk would also ship whatever else is in this worktree’s `index.ts`, including the awaited `sendLevelToChat` call.

## Watchdog-only delta in `d3c2d452` (local, not asserted as live)

1. `isWatchdog` + `reportedBottomFeet` → `tankAfterInches` from bottom, not `top - BBL/(20*tanks)`.
2. `lastPull.driverName: data.driverName \|\| null` (allow null).
3. `canonicalProcessingCompletedAt` ServerValue fallback `{'.sv':'timestamp'}` for emulator Admin SDK.
4. Export HMAC HTTPS endpoints (not part of the v1 trigger body).

## Level-to-chat interaction

Watchdog packets stamp `driverId: null` and `companyId: liquid-gold` (server). `sendLevelToChat` keys off `data.driverId` and `drivers/approved/{driverId}`. A null/missing driver should **skip** chat (not send as a driver). That skip must stay; Watchdog must not impersonate a WB-M/WB-T driver to force chat.

Claude’s repair (approved↔profiles mapping / companyId on approved records) is **orthogonal** and must not be overwritten by a Watchdog-only Functions deploy.

## Canonical Current Level vs `adminGetWellPool`

Dashboard `adminGetWellPool` does **not** read `wells/{name}/status`. It reads `well_config` + `packets/outgoing` and projects `wellStatus[wellName].currentLevel` (`dashboardCatalogProjection.projectWellStatus`).

Watchdog receipt is therefore unsuccessful unless:

1. `packets/processed/{id}.canonicalProcessingComplete === true`
2. The newest `packets/outgoing` row for that `wellName` has `lastPullPacketId === packetId` and `lastPullDateTimeUTC` matching the packet
3. `projectWellStatus` (the pool the Dashboard callable returns) shows that Current Level
4. `well_config/{wellName}` resolves to company `liquid-gold` (or unscoped in the LG pool)

Delayed older pulls must not change that outgoing Current Level (`STALE_PULL_TIME` / high-water). Duplicates replay the same outgoing row.

## Targeted eventual deploy set (when authorized; not now)

1. `ingestWatchdogPull` (already ACTIVE — only if HMAC handler bytes need refresh)
2. `getWatchdogPullReceipt` (already ACTIVE — same)
3. `processIncomingPull` **only after** a combined patch: Watchdog bottom/driverless hunk **plus** Claude’s agreed chat-identity fix, reviewed as one revision.

Do **not** deploy `processIncomingPull` from this Watchdog checkpoint alone.
