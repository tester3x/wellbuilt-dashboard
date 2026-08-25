/**
 * Bounded processed/outgoing patch planner for a governed WB-M edit.
 * Does not remint the original packet id. Empty edit times preserve
 * the original operational event time.
 *
 * NOT the production apply path. Live apply is processIncomingEdit /
 * processEditRequest. Tests must invoke that handler, not this helper.
 */
export type WbmEditLifecyclePlan = {
  ok: true;
  originalPacketId: string;
  originalEventTimeUtc: string;
  preservedOriginalEventTime: boolean;
  processedPatch: Record<string, unknown>;
  outgoingPatch: Record<string, unknown>;
};

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function planWbmEditLifecycle(input: {
  original: Record<string, unknown>;
  payload: Record<string, unknown>;
}): WbmEditLifecyclePlan | { ok: false; reason: string } {
  const originalPacketId = asString(input.original.packetId)
    || asString(input.payload.originalPacketId)
    || asString(input.payload.packetId);
  if (!originalPacketId) return { ok: false, reason: 'missing_original' };

  const originalEventTimeUtc = asString(input.original.dateTimeUTC);
  const editTime = asString(input.payload.dateTimeUTC);
  const preservedOriginalEventTime = !editTime;
  const dateTimeUTC = editTime || originalEventTimeUtc;
  const dateTime = asString(input.payload.dateTime) || asString(input.original.dateTime);

  const tankLevelFeet = typeof input.payload.tankLevelFeet === 'number'
    ? input.payload.tankLevelFeet
    : Number(input.original.tankLevelFeet);
  const bblsTaken = typeof input.payload.bblsTaken === 'number'
    ? input.payload.bblsTaken
    : Number(input.original.bblsTaken);
  const tankTopInches = Number.isFinite(tankLevelFeet) ? tankLevelFeet * 12 : 0;

  const processedPatch: Record<string, unknown> = {
    tankLevelFeet,
    tankTopInches,
    bblsTaken,
    dateTimeUTC,
    dateTime,
  };
  if (typeof input.payload.wellDown === 'boolean') {
    processedPatch.wellDown = input.payload.wellDown;
  }

  const outgoingPatch: Record<string, unknown> = {
    isEdit: true,
    originalPacketId,
    lastPullPacketId: originalPacketId,
    lastPullBbls: String(bblsTaken),
    lastPullDateTimeUTC: dateTimeUTC,
    lastPullTopLevel: tankLevelFeet,
  };

  return {
    ok: true,
    originalPacketId,
    originalEventTimeUtc,
    preservedOriginalEventTime,
    processedPatch,
    outgoingPatch,
  };
}

export async function applyWbmEditLifecycle(input: {
  update: (path: string, values: Record<string, unknown>) => Promise<unknown>;
  readOutgoing: () => Promise<unknown>;
  plan: WbmEditLifecyclePlan;
}): Promise<{ ok: true }> {
  await input.update(`packets/processed/${input.plan.originalPacketId}`, input.plan.processedPatch);
  const tree = await input.readOutgoing();
  if (tree && typeof tree === 'object' && !Array.isArray(tree)) {
    for (const [key, raw] of Object.entries(tree as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const lastId = typeof row.lastPullPacketId === 'string' ? row.lastPullPacketId : '';
      const origId = typeof row.originalPacketId === 'string' ? row.originalPacketId : '';
      if (lastId === input.plan.originalPacketId || origId === input.plan.originalPacketId) {
        await input.update(`packets/outgoing/${key}`, input.plan.outgoingPatch);
      }
    }
  }
  return { ok: true };
}
