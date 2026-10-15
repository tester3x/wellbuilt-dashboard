export async function selectWellOperatingStatus(db: { ref(path: string): any }, well: string, signal: any) {
  let selected: any = null;
  const at = Date.parse(signal.dateTimeUTC);
  const result = await db.ref(`well_operating_status/${well}`).transaction((current: any) => {
    selected = current;
    if (current && (Date.parse(current.dateTimeUTC) > at || (Date.parse(current.dateTimeUTC) === at && current.packetId !== signal.packetId))) return;
    selected = signal; return signal;
  });
  return { applied: result.committed === true, selected };
}

/** Status-only events never enter tank, load, production, or AFR calculations. */
export async function processWatchdogWellStatus(db: { ref(path: string): any }, packetId: string, packet: any, now = Date.now()): Promise<void> {
  const at = Date.parse(packet.dateTimeUTC);
  if (packet.requestType !== 'well_status' || packet.source !== 'whatsapp_watchdog' ||
      packet.watchdogProvenance?.principalId !== 'laptop-watchdog-v2' || packet.companyId !== 'liquid-gold' ||
      typeof packet.wellDown !== 'boolean' || packet.wellDownIsAuthoritative !== true ||
      packet.tankLevelFeet !== null || packet.bottomLevelFeet !== null || packet.bblsTaken !== 0 ||
      !Number.isFinite(at) || at < Date.UTC(2000, 0, 1) || at > now + 300000) throw Error('invalid_well_status_event');
  const processedPath = `packets/processed/${packetId}`;
  const existing = (await db.ref(processedPath).once('value')).val();
  if (existing) {
    if (existing.watchdogProvenance?.observationDigest !== packet.watchdogProvenance.observationDigest || existing.wellDown !== packet.wellDown) throw Error('status_packet_collision');
    await db.ref(`packets/incoming/${packetId}`).remove(); return;
  }
  const well = packet.wellName;
  const config = (await db.ref(`well_config/${well}`).once('value')).val();
  if (!config || (config.companyId && config.companyId !== packet.companyId)) throw Error('status_well_not_allowed');
  const signal = { packetId, dateTimeUTC: packet.dateTimeUTC, wellDown: packet.wellDown };
  const selected = await selectWellOperatingStatus(db, well, signal);
  if (selected.applied) {
    const project = async (path: string, outgoing = false, configRecord = false) => {
      await db.ref(path).transaction((current: any) => {
        if (!current && outgoing) return;
        const stamp = configRecord || outgoing ? current?.wellStatusObservedAtUTC : current?.operatingStatus?.dateTimeUTC;
        if (stamp && Date.parse(stamp) > at) return;
        return { ...(current || {}), ...(outgoing ? { wellDown: signal.wellDown } : { isDown: signal.wellDown }),
          ...(configRecord || outgoing ? { wellStatusObservedAtUTC: signal.dateTimeUTC } : { operatingStatus: signal }) };
      });
    };
    await project(`wells/${well}/status`);
    await project(`well_config/${well}`, false, true);
    const outgoing = (await db.ref('packets/outgoing').orderByChild('wellName').equalTo(well).once('value')).val() || {};
    for (const key of Object.keys(outgoing)) await project(`packets/outgoing/${key}`, true);
  }
  await db.ref('').update({
    [processedPath]: { ...packet, packetId, noLevel: true, statusOnly: true,
      statusApplied: selected.applied, canonicalProcessingComplete: true, processedAt: new Date(now).toISOString() },
    [`packets/incoming/${packetId}`]: null,
  });
}
