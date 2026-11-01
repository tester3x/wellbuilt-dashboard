/** Governed conversations live outside legacy company-readable chat_threads.
 * Protocol mirrored in WB T functions/src/dispatchConversations.ts. No rules
 * deployment: the existing catch-all denies direct client access here. */
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
export const CONVERSATIONS = 'dispatch_conversations';
export type Audience = 'dispatch_team' | 'private_driver';
export function conversationId(company: string, driver: string, staff?: string): string {
  return (staff ? 'private_' : 'dispatch_') + createHash('sha256')
    .update(JSON.stringify(staff ? [company, driver, staff] : [company, driver])).digest('hex');
}
export const governedId = (id: string): boolean => /^(dispatch|private)_[a-f0-9]{64}$/.test(id);
export const conversationCollection = (id: string): string => governedId(id) ? CONVERSATIONS : 'chat_threads';
export function validConversation(row: any, id: string): boolean {
  if (!row || !['dispatch_team', 'private_driver'].includes(row.audience) || row.type !== 'direct' ||
      typeof row.driverId !== 'string' || !row.driverId || !row.companyId) return false;
  const privateChat = row.audience === 'private_driver';
  if (privateChat && (typeof row.staffUid !== 'string' || !row.staffUid)) return false;
  return id === conversationId(row.companyId, row.driverId, privateChat ? row.staffUid : undefined) &&
    Array.isArray(row.participants) && row.participants.includes(`driver:${row.driverId}`) &&
    (!privateChat || (row.participants.length === 2 && row.participants.includes(`user:${row.staffUid}`)));
}
export async function ensureConversation(company: string, driver: string, driverName: string, staff?: { uid: string; name: string }): Promise<string> {
  const id = conversationId(company, driver, staff?.uid), ref = admin.firestore().collection(CONVERSATIONS).doc(id);
  await admin.firestore().runTransaction(async tx => {
    const old = await tx.get(ref);
    if (old.exists) {
      if (!validConversation(old.data(), id)) throw new Error('Conversation identity conflict');
      return; // Never reopen, reset reads, duplicate history, or depend on a staff roster.
    }
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    tx.create(ref, { companyId: company, driverId: driver, ...(staff ? { staffUid: staff.uid } : {}),
      audience: staff ? 'private_driver' : 'dispatch_team', type: 'direct',
      title: driverName, subtitle: staff ? `Private with ${staff.name}` : 'Dispatch team',
      participants: [`driver:${driver}`, ...(staff ? [`user:${staff.uid}`] : [])], participantIds: [driver],
      participantNames: { [`driver:${driver}`]: driverName, ...(staff ? { [`user:${staff.uid}`]: staff.name } : {}) },
      status: 'active', broadcast: false, createdAt: stamp, updatedAt: stamp, lastRead: {} });
  });
  return id;
}

/** Consolidate only legacy direct threads demonstrably used by the shift writer.
 * Explicit private/peer/group chats are never inferred to be dispatch history. */
export async function consolidateDispatchHistory(company: string, driver: string, name: string, keys: string[] = [driver]): Promise<string> {
  const id = await ensureConversation(company, driver, name), db = admin.firestore();
  const own = new Set([driver, ...keys].map(key => `driver:${key}`));
  const allowed = (row: any): boolean => row?.companyId === company && row.type === 'direct' && !row.audience && !row.supersededBy &&
    Array.isArray(row.participants) && row.participants.some((p: string) => own.has(p)) &&
    row.participants.some((p: string) => p.startsWith('user:')) &&
    row.participants.every((p: string) => own.has(p) || p.startsWith('user:'));
  const batches = await Promise.all([...own].map(participant => db.collection('chat_threads')
    .where('companyId', '==', company).where('participants', 'array-contains', participant).get()));
  const sources = new Map<string, admin.firestore.DocumentReference>();
  for (const batch of batches) for (const doc of batch.docs) if (allowed(doc.data())) sources.set(doc.id, doc.ref);
  const target = db.collection(CONVERSATIONS).doc(id);
  const ms = (value: any): number => value?.toMillis?.() || (typeof value === 'string' ? Date.parse(value) : 0) || 0;
  for (const source of sources.values()) {
    let more = true;
    while (more) more = await db.runTransaction(async tx => {
    const [legacy, current, messages, copiedMessages] = await Promise.all([tx.get(source), tx.get(target),
      tx.get(source.collection('messages')), tx.get(target.collection('messages').where('legacySource.threadId', '==', source.id))]);
    if (!allowed(legacy.data())) return false;
    if (!messages.docs.some(doc => doc.get('type') === 'system' && doc.get('systemType') === 'shift_started')) return false;
    if (!validConversation(current.data(), id)) throw new Error('Dispatch history target changed');
    const alreadyCopied = new Set(copiedMessages.docs.map(doc => doc.id));
    const copiedId = (messageId: string) => 'legacy_' + createHash('sha256').update(JSON.stringify([source.id, messageId])).digest('hex');
    const missing = messages.docs.filter(doc => !alreadyCopied.has(copiedId(doc.id)));
    let latest: any = null;
    for (const message of missing.slice(0, 400)) {
      const row = message.data(), sender = String(row.senderId || '');
      const ownActivity = own.has(sender) || (sender === 'system' && ['shift_start', 'shift_started', 'shift_ended'].includes(row.systemType));
      const copied: Record<string, any> = { ...row, ...(ownActivity ? { senderId: `driver:${driver}`, senderName: name } : {}),
        legacySource: { threadId: source.id, messageId: message.id, senderId: sender, senderName: row.senderName || '' } };
      const messageId = copiedId(message.id);
      tx.create(target.collection('messages').doc(messageId), copied);
      if (!latest || ms(copied.timestamp || copied.createdAt) > ms(latest.timestamp || latest.createdAt)) latest = copied;
    }
    const update: Record<string, any> = { historyMigrationVersion: 1 };
    if (missing.length <= 400) update.legacyThreadIds = admin.firestore.FieldValue.arrayUnion(source.id);
    if (latest && ms(latest.timestamp || latest.createdAt) > ms(current.get('lastMessage')?.timestamp)) {
      update.lastMessage = { text: latest.text || 'Photo', senderId: latest.senderId, senderName: latest.senderName || '',
        timestamp: latest.timestamp || latest.createdAt, type: latest.type || 'text' };
      update.updatedAt = latest.timestamp || latest.createdAt;
    }
    tx.update(target, update);
    if (missing.length > 400) return true;
    // Stops old Suite clients querying type=direct from continuing to post here.
    // Both governed APIs redirect saved IDs, and original history remains intact.
    tx.update(source, { supersededBy: id, supersededAt: admin.firestore.FieldValue.serverTimestamp(),
      type: 'dispatch_history', legacyOriginalType: 'direct', status: 'archived' });
    return false;
    });
  }
  return id;
}
