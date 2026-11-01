import * as admin from 'firebase-admin';

const millis = (value: any): number => value?.toMillis?.() || (typeof value === 'string' ? Date.parse(value) : 0) || 0;

/** Count messages, not people or threads. Own automatic reports are outgoing. */
export function summarizeUnreadMessages(messages: any[], thread: any, participant: string, aliases: string[] = []) {
  const own = new Set([participant, ...aliases]);
  const readAt = Math.max(0, ...[...own].map(id => millis(thread.lastRead?.[id])));
  const driverIds = (thread.participants || []).filter((id: string) => id.startsWith('driver:'));
  const soleOwnDriver = participant.startsWith('driver:') && driverIds.length > 0 && driverIds.every((id: string) => own.has(id));
  const incoming = messages.filter(message => {
    const sender = String(message.senderId || '');
    if (own.has(sender) || own.has(`driver:${sender}`)) return false;
    if (soleOwnDriver && sender === 'system' && ['shift_start', 'shift_started', 'shift_ended'].includes(message.systemType)) return false;
    return millis(message.timestamp || message.createdAt) > readAt;
  }).sort((a, b) => millis(b.timestamp || b.createdAt) - millis(a.timestamp || a.createdAt));
  const latest = incoming[0];
  return { unreadCount: incoming.length, ...(latest ? { lastUnreadMessage: {
    text: latest.text || (latest.photoUrl ? 'Photo' : 'New message'), senderId: latest.senderId,
    senderName: latest.senderName || '', timestamp: latest.timestamp || latest.createdAt, type: latest.type || 'text',
  } } : {}) };
}

export async function readUnreadSummary(ref: admin.firestore.DocumentReference, thread: any, participant: string, aliases: string[] = []) {
  const readAt = Math.max(0, ...[participant, ...aliases].map(id => millis(thread.lastRead?.[id])));
  if (thread.lastMessage && millis(thread.lastMessage.timestamp) <= readAt) return { unreadCount: 0 };
  const cutoff = admin.firestore.Timestamp.fromMillis(readAt);
  const batches = await Promise.all(['timestamp', 'createdAt'].map(field => ref.collection('messages').where(field, '>', cutoff).get()));
  const messages = new Map<string, any>();
  for (const batch of batches) for (const doc of batch.docs) messages.set(doc.id, doc.data());
  return summarizeUnreadMessages([...messages.values()], thread, participant, aliases);
}
