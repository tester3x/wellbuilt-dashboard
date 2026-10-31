/** Preserve old per-shift documents as sources of one driver/company chat. */
type Row = Record<string, any>;
export const chatTime = (value: any): number => value?.toMillis?.() || Date.parse(value || '') || 0;
export function shiftConversationKey(row: Row): string | null {
  if (row.type !== 'shift' || typeof row.companyId !== 'string' || !row.companyId) return null;
  const drivers = [...new Set<string>((Array.isArray(row.participants) ? row.participants : [])
    .filter((id: any) => typeof id === 'string' && id.startsWith('driver:')))];
  return drivers.length === 1 ? `${row.companyId}:${drivers[0]}` : null;
}

export function continuousShiftChats(rows: Row[]): Row[] {
  const groups = new Map<string, Row[]>(), separate: Row[] = [];
  for (const row of rows) {
    const key = shiftConversationKey(row);
    if (!key) { separate.push(row); continue; }
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  for (const members of groups.values()) {
    members.sort((a, b) => chatTime(a.createdAt) - chatTime(b.createdAt) || a.id.localeCompare(b.id));
    const anchor = members[0];
    const latest = [...members].sort((a, b) => chatTime(b.updatedAt || b.createdAt) - chatTime(a.updatedAt || a.createdAt))[0];
    const lastMessage = members.map(row => row.lastMessage).filter(Boolean)
      .sort((a, b) => chatTime(b.timestamp) - chatTime(a.timestamp))[0];
    const participants = [...new Set(members.flatMap(row => row.participants || []))];
    const lastRead: Row = {};
    for (const id of participants) {
      // Never hide an unread day just because another day's chat was read.
      if (members.every(row => row.lastRead?.[id])) {
        lastRead[id] = members.map(row => row.lastRead[id]).sort((a, b) => chatTime(a) - chatTime(b))[0];
      }
    }
    separate.push({ ...anchor, updatedAt: latest.updatedAt || latest.createdAt,
      status: members.some(row => row.status !== 'archived') ? 'active' : 'archived',
      participants, participantNames: Object.assign({}, ...members.map(row => row.participantNames || {})),
      lastRead, ...(lastMessage ? { lastMessage } : {}), sourceThreadIds: members.map(row => row.id) });
  }
  return separate;
}

/** Message document IDs are local to a source thread, not globally unique. */
export function continuousChatMessages(rows: Row[], limit: number): Row[] {
  const seen = new Set<string>();
  return rows.sort((a, b) => chatTime(b.timestamp) - chatTime(a.timestamp) || a.id.localeCompare(b.id))
    .filter(row => {
      const identity = row.clientId && row.senderId ? `${row.senderId}:${row.clientId}` : row.id;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    }).slice(0, limit).reverse();
}
