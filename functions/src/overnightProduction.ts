export interface HistoricalProductionReading {
  timestamp: number;
  tankLevelFeet: number;
  bblsTaken: number;
  wellDown?: boolean;
  provisional?: boolean;
  /** undefined: legacy record without bottom; null: invalid recorded bottom. */
  bottomLevelFeet?: number | null;
}

/** Prefer the bottom persisted with this reading, not a new subtraction using
 * today's calibration. An invalid explicit measurement is not legacy absence. */
export function recordedBottomFeet(packet: Record<string, any>): number | null | undefined {
  const top = Number(packet.tankLevelFeet);
  const valid = (feet: number) => Number.isFinite(feet) && feet >= 0 && Number.isFinite(top) && feet <= top ? feet : null;
  if (packet.tankAfterInches != null) {
    if (!['number', 'string'].includes(typeof packet.tankAfterInches) || packet.tankAfterInches === '') return null;
    return valid(Number(packet.tankAfterInches) / 12);
  }
  if (packet.tankAfterFeet != null && packet.tankAfterFeet !== '') {
    const match = String(packet.tankAfterFeet).match(/^\s*(\d+)\s*'\s*(\d+(?:\.\d+)?)?\s*"?\s*$/);
    if (!match || Number(match[2] || 0) >= 12) return null;
    return valid(Number(match[1]) + Number(match[2] || 0) / 12);
  }
  const proof = packet.watchdogProvenance;
  if (packet.source === 'whatsapp_watchdog' && proof?.principalId === 'laptop-watchdog-v2' && proof.reportedBottomFeet != null) {
    return valid(Number(proof.reportedBottomFeet));
  }
  return undefined;
}

/** Last reading of the previous Central day to first reading of the current
 * Central day. AFR remains a separate smoothed estimate. */
export function calculateOvernightProduction(
  readings: HistoricalProductionReading[], bblPerFoot: number, at: number,
  mode: 'overnight' | 'afr' = 'overnight',
): number {
  // Continuous hauling has no distinct overnight sample. Publishing no ON
  // estimate lets the app honestly use AFR without an ON label.
  if (mode === 'afr') return 0;
  if (!Number.isFinite(at) || !Number.isFinite(bblPerFoot) || bblPerFoot <= 0) return 0;
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'});
  const today = date.format(at);
  const ordered = readings.filter(r => Number.isFinite(r.timestamp) && r.timestamp <= at).slice().sort((a, b) => a.timestamp - b.timestamp);
  let first: HistoricalProductionReading | undefined;
  let previous: HistoricalProductionReading | undefined;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (date.format(ordered[i].timestamp) === today) first = ordered[i];
    else { previous = ordered[i]; break; }
  }
  if (!first || !previous || first.wellDown || previous.wellDown || first.provisional || previous.provisional) return 0;
  if (!(first.tankLevelFeet > 0) || !(previous.tankLevelFeet > 0)) return 0;
  const bottom = previous.bottomLevelFeet === undefined
    ? Math.max(previous.tankLevelFeet - previous.bblsTaken / bblPerFoot, 0)
    : previous.bottomLevelFeet;
  if (bottom === null || !Number.isFinite(bottom) || bottom < 0 || bottom > previous.tankLevelFeet) return 0;
  const days = (first.timestamp - previous.timestamp) / 86400000;
  const recovery = first.tankLevelFeet - bottom;
  if (!(days > 0) || !(recovery > 0)) return 0;
  return Math.round(recovery * bblPerFoot / days);
}
