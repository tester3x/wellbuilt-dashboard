/** Offline diagnostic only. No database client or writes. Input times must be verified UTC. */
export function replayFlow(observations, minimumRecoveryInches = 6) {
  if (!(minimumRecoveryInches > 0)) throw new Error('Positive recovery threshold required');
  let anchor = null, removedInches = 0, retainedHoursPerFoot = null, totalBarrels = 0;
  const result = [];
  const seen = new Set();
  for (const row of [...observations].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
    if (!row.id || seen.has(row.id)) throw new Error('Missing or duplicate observation identity');
    seen.add(row.id);
    const time = Date.parse(row.time);
    if (!Number.isFinite(time)) throw new Error('Invalid timestamp');
    if (row.barrier || row.down || ![row.topInches, row.bottomInches, row.barrels].every(Number.isFinite)
        || row.barrels < 0 || row.topInches < row.bottomInches) {
      anchor = null; removedInches = 0; retainedHoursPerFoot = null;
      result.push({ ...row, action: 'break', hoursPerFoot: null });
      continue;
    }
    totalBarrels += row.barrels;
    if (!anchor) {
      anchor = { time, bottom: row.bottomInches };
      result.push({ ...row, action: 'anchor', hoursPerFoot: retainedHoursPerFoot });
      continue;
    }
    const hours = (time - anchor.time) / 3600000;
    // Intervening measured drops restore removed water; current load is not yet removed.
    const recoveryInches = row.topInches - anchor.bottom + removedInches;
    if (hours <= 0 || recoveryInches < 0 || hours > 720) {
      retainedHoursPerFoot = null;
      anchor = { time, bottom: row.bottomInches }; removedInches = 0;
      result.push({ ...row, action: 'reset', recoveryInches, hoursPerFoot: null });
    } else if (recoveryInches >= minimumRecoveryInches) {
      retainedHoursPerFoot = hours * 12 / recoveryInches;
      anchor = { time, bottom: row.bottomInches }; removedInches = 0;
      result.push({ ...row, action: 'update', recoveryInches, hoursPerFoot: retainedHoursPerFoot });
    } else {
      removedInches += row.topInches - row.bottomInches;
      result.push({ ...row, action: 'hold', recoveryInches, hoursPerFoot: retainedHoursPerFoot });
    }
  }
  return { totalBarrels, observations: result };
}
