import type { AfrInterval } from './afrTypes';

/** Keep raw observations as interval boundaries, even when their own rate is zero. */
export function buildAfrIntervals(history: Record<string, any>, bblPerFoot?: number, incoming?: any): AfrInterval[] {
  const rows = Object.entries(history).filter(([key, row]) => row && !/^(edit_|delete_|history_)/.test(key) && !row.deleted && row.requestType !== 'delete' && !(key.startsWith('idem_') && history[key.slice(5)]))
    .map(([key, row]) => ({...row, key, timestamp: Date.parse(row.dateTimeUTC || row.gaugeTime || row.dateTime || '')}));
  if (incoming && !rows.some(row => row.timestamp === incoming.timestamp)) rows.push(incoming);
  rows.sort((a, b) => a.timestamp - b.timestamp);
  // Earlier operating runs cannot seed the restarted well's AFR.
  let lastDown = -1;
  rows.forEach((row, i) => { if (row.wellDown === true || row.wellDown === 'true') lastDown = i; });
  return rows.flatMap((row, i) => {
    if (i < lastDown || !(row.flowRateDays > 0)) return [];
    const prior = rows[i - 1];
    const gap = prior ? row.timestamp - prior.timestamp : undefined;
    // Stored elapsed time must agree with the actual adjacent observation times.
    // A one-minute allowance accommodates old timestamp rounding.
    const corruptTiming = gap !== undefined && typeof row.timeDifDays === 'number' && row.timeDifDays > 0 && Math.abs(row.timeDifDays * 86400000 - gap) > 60000;
    return [{key: row.key, timestamp: row.timestamp, flowRateDays: row.flowRateDays,
      intervalMs: corruptTiming ? 0 : gap,
      topLevelFeet: row.tankLevelFeet, priorTopLevelFeet: prior?.tankLevelFeet,
      bblsTaken: prior?.bblsTaken, bblPerFoot,
      wellDown: row.wellDown === true || row.wellDown === 'true',
      priorWellDown: prior?.wellDown === true || prior?.wellDown === 'true'}];
  });
}
