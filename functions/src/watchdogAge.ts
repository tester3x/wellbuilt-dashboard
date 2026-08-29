// watchdogAge.ts — trusted age estimation for stranded-packet recovery.
//
// The deployed watchdog estimated a packet's age by parsing the packet-KEY
// timestamp as UTC. Keys are minted on the client in LOCAL time, so every
// CDT-minted key looked ~5 hours old the moment it landed: on 2026-08-28 the
// sweep at 14:25:08.889Z judged `20260828_092503_Crossbow1_dstw6f` (ingested
// 694 ms earlier, 14:25:08.195Z) as five hours stranded and cloned it into a
// re-keyed duplicate. Age must come from the server-stamped `ingestedAt`
// (epoch ms, written by the ingest callable with Date.now()) — never from a
// locally-formatted key. A packet whose ingestedAt is missing or malformed has
// UNKNOWN age and is never classified stranded from a guess.

/** Same 2-minute stranded threshold the watchdog has always used. */
export const STRANDED_THRESHOLD_MS = 2 * 60 * 1000;

export type PacketAge =
  | { kind: 'known'; ageMs: number }
  | { kind: 'unknown'; reason: 'missing_ingestedAt' | 'malformed_ingestedAt' };

/** Sanity window for a server-stamped epoch-ms value (2020..2100). */
const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

/**
 * Age from the server-stamped ingestedAt ONLY. The packet key is deliberately
 * not consulted: its timestamp is client-local and unlabeled, and mis-parsing
 * it as UTC is the exact deployed defect this module replaces. An ingestedAt
 * slightly in the future (clock skew between server instances) clamps to 0.
 */
export function estimatePacketAge(
  packet: { ingestedAt?: unknown } | null | undefined,
  nowMs: number,
): PacketAge {
  const raw = packet?.ingestedAt;
  if (raw === undefined || raw === null) {
    return { kind: 'unknown', reason: 'missing_ingestedAt' };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < MIN_PLAUSIBLE_MS || n > MAX_PLAUSIBLE_MS) {
    return { kind: 'unknown', reason: 'malformed_ingestedAt' };
  }
  return { kind: 'known', ageMs: Math.max(0, nowMs - n) };
}

/**
 * Stranded means PROVEN older than the threshold. Unknown age is never
 * stranded — recovery for a packet we cannot age flows through the canonical
 * coordinator's receipt/lock inspection, not a guessed clone.
 */
export function isStranded(age: PacketAge, thresholdMs: number = STRANDED_THRESHOLD_MS): boolean {
  return age.kind === 'known' && age.ageMs > thresholdMs;
}
