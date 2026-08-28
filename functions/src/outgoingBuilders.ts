// outgoingBuilders.ts — pure builders for the outgoing/current response,
// extracted VERBATIM from processIncomingPull (object assembly separated from
// the db.ref().set persistence). The server-time placeholder (timestampIso) is
// injected so the builder is pure/testable. Field keys, formatting, null-vs-
// omitted, and status are preserved exactly.
import { inchesToFeetInches, daysToHMMSS, formatLocalDateTime, outgoingCompanyId } from './wbmFormat';

export interface OutgoingResponseInputs {
  wellName: string;
  currentLevelInches: number;
  afr: number;
  bbls24hrs: string;
  nextIsDown: boolean;
  estTimeToPull: string;
  estDateTimePull: string;
  dateTime?: string;
  dateTimeUTC: string;
  bblsTaken: number;
  driverId?: string | null;
  driverName?: string | null;
  tankTopInches: number;
  tankAfterInches: number;
  packetId: string;
  config: { companyId?: unknown };
  /** Server timestamp (ISO) — injected so the builder stays pure. */
  timestampIso: string;
  windowBblsDay: number;
  overnightBblsDay: number;
}

export function buildOutgoingResponse(i: OutgoingResponseInputs): Record<string, unknown> {
  return {
    wellName: i.wellName,
    currentLevel: inchesToFeetInches(i.currentLevelInches),
    flowRate: i.afr > 0 ? daysToHMMSS(i.afr) : 'Unknown',
    bbls24hrs: i.bbls24hrs,
    timeTillPull: i.nextIsDown ? 'Down' : (i.estTimeToPull || 'Calculating...'),
    nextPullTime: i.estDateTimePull ? formatLocalDateTime(new Date(i.estDateTimePull)) : 'Unknown',
    nextPullTimeUTC: i.estDateTimePull,
    lastPullDateTime: i.dateTime || formatLocalDateTime(new Date(i.dateTimeUTC)),
    lastPullDateTimeUTC: i.dateTimeUTC,
    lastPullBbls: i.bblsTaken.toString(),
    lastPullTopLevel: inchesToFeetInches(i.tankTopInches),
    lastPullBottomLevel: inchesToFeetInches(i.tankAfterInches),
    lastPullDriverId: i.driverId || null,
    lastPullDriverName: i.driverName || null,
    lastPullPacketId: i.packetId,
    wellDown: i.nextIsDown,
    companyId: outgoingCompanyId(i.config),
    status: 'success',
    timestamp: i.timestampIso,
    timestampUTC: i.timestampIso,
    windowBblsDay: i.windowBblsDay > 0 ? i.windowBblsDay.toString() : null,
    overnightBblsDay: i.overnightBblsDay > 0 ? i.overnightBblsDay.toString() : null,
  };
}

export interface WellStatusInputs {
  wellName: string;
  tanks: number;
  bottomInches: number;
  route?: string;
  pullBbls: number;
  currentLevelInches: number;
  dateTime?: string;
  dateTimeUTC: string;
  tankTopInches: number;
  tankAfterInches: number;
  bblsTaken: number;
  driverName?: string;
  packetId: string;
  afr: number;
  afrMinutes: number;
  bbls24hrs: string;
  estDateTimePull: string;
  estTimeToPull: string;
  nextIsDown: boolean;
  /** Server timestamp (ISO) — injected; used for both current.asOf and updatedAt
   *  (the original took two separate near-identical `new Date()` reads). */
  nowIso: string;
}

export function buildWellStatus(i: WellStatusInputs): Record<string, unknown> {
  return {
    wellName: i.wellName,
    config: {
      tanks: i.tanks,
      bottomLevel: i.bottomInches / 12, // Convert back to feet
      route: i.route || 'Unassigned',
      pullBbls: i.pullBbls,
    },
    current: {
      level: inchesToFeetInches(i.currentLevelInches),
      levelInches: i.currentLevelInches,
      asOf: i.nowIso,
    },
    lastPull: {
      dateTime: i.dateTime || formatLocalDateTime(new Date(i.dateTimeUTC)),
      dateTimeUTC: i.dateTimeUTC,
      topLevel: inchesToFeetInches(i.tankTopInches),
      topLevelInches: i.tankTopInches,
      bottomLevel: inchesToFeetInches(i.tankAfterInches),
      bottomLevelInches: i.tankAfterInches,
      bblsTaken: i.bblsTaken,
      driverName: i.driverName,
      packetId: i.packetId,
    },
    calculated: {
      flowRate: i.afr > 0 ? daysToHMMSS(i.afr) : 'Unknown',
      flowRateMinutes: Math.round(i.afrMinutes * 100) / 100,
      bbls24hrs: parseInt(i.bbls24hrs) || 0,
      nextPullTime: i.estDateTimePull ? formatLocalDateTime(new Date(i.estDateTimePull)) : 'Unknown',
      nextPullTimeUTC: i.estDateTimePull || '',
      timeTillPull: i.nextIsDown ? 'Down' : (i.estTimeToPull || 'Calculating...'),
    },
    isDown: i.nextIsDown,
    updatedAt: i.nowIso,
  };
}
