/** Chat labels use real profile names, never authentication/display aliases. */
type Row = Record<string, any>;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export const UNKNOWN_CHAT_NAME = 'Name unavailable';
export function realChatName(row: Row | null | undefined): string {
  return text(row?.legalName) || text(row?.profile?.legalName) || text(row?.fullName) ||
    (text(row?.firstName) && text(row?.lastName) ? `${text(row?.firstName)} ${text(row?.lastName)}` : '');
}

export function chatNameDirectory(companyId: string, profiles: Row, approved: Row, users: Row, aliases: Map<string, string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [id, row] of Object.entries(approved)) {
    if (row?.companyId === companyId && realChatName(row)) names.set(`driver:${id}`, realChatName(row));
  }
  for (const [id, row] of Object.entries(profiles)) {
    if (row?.companyId !== companyId) continue;
    let name = realChatName(row);
    if (!name) {
      const linked = [...aliases].filter(([, canonical]) => canonical === `driver:${id}`)
        .map(([alias]) => names.get(alias)).filter(Boolean);
      const unique = [...new Set(linked)];
      if (unique.length === 1) name = unique[0]!;
    }
    names.set(`driver:${id}`, name || UNKNOWN_CHAT_NAME);
  }
  for (const [alias, canonical] of aliases) {
    if (names.has(canonical)) names.set(alias, names.get(canonical)!);
  }
  for (const [uid, row] of Object.entries(users)) {
    if (row?.companyId !== companyId) continue;
    const ownName = realChatName(row);
    const driverId = text(row.driverId) || text(row.driverHash);
    const direct = driverId ? names.get(`driver:${driverId}`) : undefined;
    const stamped = Object.entries(profiles).filter(([, p]) => p?.companyId === companyId && p.dashboardUid === uid)
      .map(([id]) => names.get(`driver:${id}`));
    const unique = [...new Set(stamped.filter(Boolean))];
    names.set(`user:${uid}`, ownName || direct || (unique.length === 1 ? unique[0] : undefined) || UNKNOWN_CHAT_NAME);
  }
  return names;
}

const personName = (id: unknown, saved: unknown, names: Map<string, string>) =>
  typeof id === 'string' && /^(driver|user):/.test(id)
    ? names.get(id) || UNKNOWN_CHAT_NAME : saved;

export function presentChatThread(row: Row, names: Map<string, string>, aliases: Map<string, string>): Row {
  const participants: string[] = [...new Set<string>((row.participants || []).map((id: string) => aliases.get(id) || id))];
  const participantNames = Object.fromEntries(participants.map(id => [id, personName(id, row.participantNames?.[id], names)]));
  const drivers = participants.filter(id => id.startsWith('driver:'));
  const title = ['shift', 'direct'].includes(row.type) && drivers.length === 1
    ? names.get(drivers[0]) || UNKNOWN_CHAT_NAME : row.title;
  return { ...row, title, participants, participantNames,
    ...(row.lastMessage ? { lastMessage: presentChatMessage(row.lastMessage, names) } : {}) };
}

export function presentChatMessage(row: Row, names: Map<string, string>): Row {
  return { ...row, senderName: personName(row.senderId, row.senderName, names) };
}
