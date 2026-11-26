/** A zero-barrel observation is not proof that a physical pickup already happened. */
export function needsPickupWatermark(incoming: any, outgoing: any): boolean {
  return Number(incoming?.bblsTaken) > 0 && outgoing != null
    && Number(outgoing.lastPullBbls) === 0
    && Date.parse(incoming.dateTimeUTC) <= Date.parse(outgoing.lastPullDateTimeUTC);
}

export function latestPhysicalPickup(records: Record<string, any>, wellName: string): any | null {
  let latest: any = null;
  for (const [key, record] of Object.entries(records)) {
    if (/^(edit_|delete_|history_)/.test(key) || record?.wellName !== wellName
      || (record.requestType && record.requestType !== 'pull') || !(Number(record.bblsTaken) > 0)) continue;
    if (!Number.isFinite(Date.parse(record.dateTimeUTC))) throw Error('Physical pickup watermark is unreadable');
    if (!latest || Date.parse(record.dateTimeUTC) > Date.parse(latest.dateTimeUTC)) {
      latest = { ...record, packetId: key };
    }
  }
  return latest;
}
