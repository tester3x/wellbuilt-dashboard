/** Company-wide, immutable dispatch notices. Access is callable-only: no client
 * membership, shift state, read marker, archive flag or claimed role grants access.
 * Kept byte-identical in both deploying chat lanes. */
import * as admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v1/https';
import { createHash } from 'crypto';

export const ANNOUNCEMENTS = 'dispatch_announcements';
export const announcementId = (companyId: string) => 'announcements_' + createHash('sha256').update(companyId).digest('hex');
export const isAnnouncementId = (id: unknown) => typeof id === 'string' && id.startsWith('announcements_');
type Actor = { companyId: string; id: string; name: string; staff: boolean };
type Recipient = { hash: string; name: string };
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const time = (v: any): number => v?.toMillis?.() || Date.parse(v || '') || 0;
const key = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(v)) throw new HttpsError('invalid-argument', 'Invalid announcement identifier');
  return v;
};
const denied = (): never => { throw new HttpsError('permission-denied', 'Dispatch Announcements is permanent; only dispatch can post and drivers can acknowledge'); };
const receiptKey = (messageId: string, driverId: string) => createHash('sha256').update(JSON.stringify([messageId, driverId])).digest('hex');
const refFor = (companyId: string) => admin.firestore().collection(ANNOUNCEMENTS).doc(announcementId(companyId));
async function rowsFor(actor: Actor) {
  const ref = refFor(actor.companyId);
  const messages = actor.staff ? await ref.collection('messages').get()
    : await ref.collection('messages').where('recipientIds', 'array-contains', actor.id).get();
  const receipts = actor.staff ? await ref.collection('receipts').get()
    : await ref.collection('receipts').where('driverId', '==', actor.id).get();
  const received = new Map(receipts.docs.map(doc => [doc.id, doc.data()]));
  return messages.docs.map(doc => {
    const row = doc.data();
    if (row.companyId !== actor.companyId) throw new HttpsError('permission-denied', 'Announcement company mismatch');
    const acknowledgedAt = received.get(receiptKey(doc.id, actor.id))?.acknowledgedAt || null;
    const recipients: Recipient[] = Array.isArray(row.recipients) ? row.recipients : [];
    return { id: doc.id, text: row.text, senderId: row.senderId, senderName: row.senderName, type: 'text',
      timestamp: row.timestamp, clientId: row.clientId, requiresAcknowledgement: true,
      ...(!actor.staff ? { acknowledgedAt } : { receiptSummary: recipients.map(recipient => ({ driverId: recipient.hash,
        name: recipient.name, acknowledgedAt: received.get(receiptKey(doc.id, recipient.hash))?.acknowledgedAt || null })) }) };
  }).sort((a,b) => time(a.timestamp) - time(b.timestamp) || a.id.localeCompare(b.id));
}
export async function announcementThread(actor: Actor): Promise<any> {
  const rows = await rowsFor(actor), latest = rows[rows.length - 1];
  const pending = actor.staff ? [] : rows.filter(row => !(row as any).acknowledgedAt);
  const preview = (row: any) => row ? { text: row.text, senderId: row.senderId, senderName: row.senderName, timestamp: row.timestamp, type: 'text' } : undefined;
  return { id: announcementId(actor.companyId), companyId: actor.companyId, type: 'announcements',
    title: 'Dispatch Announcements', subtitle: 'All drivers · acknowledgement required', permanent: true, broadcast: true,
    participants: [actor.staff ? 'user:' + actor.id : 'driver:' + actor.id], participantNames: {}, status: 'active', lastRead: {},
    createdAt: latest?.timestamp || new Date(0).toISOString(), updatedAt: latest?.timestamp || new Date(0).toISOString(),
    unreadCount: pending.length, pendingAcknowledgements: pending.length,
    ...(latest ? { lastMessage: preview(latest) } : {}), ...(pending.length ? { lastUnreadMessage: preview(pending[pending.length-1]) } : {}) };
}
export async function handleAnnouncement(actor: Actor, data: any, recipients?: () => Promise<Recipient[]>): Promise<any> {
  if (data.threadId !== announcementId(actor.companyId)) throw new HttpsError('permission-denied', 'Announcement outside your company');
  const ref = refFor(actor.companyId), action = data.action;
  if (action === 'thread') return { thread: await announcementThread(actor) };
  // Opening the drawer never acknowledges anything. No lastRead mutation.
  if (action === 'read') return { ok: true };
  if (action === 'messages') { const rows = await rowsFor(actor); return { rows, messages: rows }; }
  if (action === 'acknowledge' && !actor.staff) {
    const messageId = key(data.messageId), message = ref.collection('messages').doc(messageId);
    const receipt = ref.collection('receipts').doc(receiptKey(messageId, actor.id));
    return admin.firestore().runTransaction(async tx => {
      const [notice, previous] = await Promise.all([tx.get(message), tx.get(receipt)]);
      if (!notice.exists || notice.get('companyId') !== actor.companyId || !notice.get('recipientIds')?.includes(actor.id)) denied();
      if (previous.exists && (previous.get('companyId') !== actor.companyId || previous.get('messageId') !== messageId || previous.get('driverId') !== actor.id)) denied();
      if (!previous.exists) tx.create(receipt, { companyId: actor.companyId, messageId, driverId: actor.id, acknowledgedAt: stamp() });
      return { ok: true, messageId, duplicate: previous.exists };
    });
  }
  if (action !== 'send' || !actor.staff || !recipients || data.photoPath || data.base64) denied();
  const clientId = key(data.clientId), text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text || text.length > 4000) throw new HttpsError('invalid-argument', 'Announcement must contain 1–4000 characters');
  if (!actor.name || actor.name === 'Name unavailable') throw new HttpsError('failed-precondition', 'Link your real employee name before posting announcements');
  const roster = [...new Map((await recipients!()).map(row => [row.hash, row])).values()];
  if (!roster.length) throw new HttpsError('failed-precondition', 'No active drivers in this company');
  // Bound document size explicitly; never silently omit drivers.
  if (roster.length > 1500) throw new HttpsError('resource-exhausted', 'Announcement audience needs server batching');
  const message = ref.collection('messages').doc('c_' + clientId);
  return admin.firestore().runTransaction(async tx => {
    const previous = await tx.get(message);
    if (previous.exists) {
      if (previous.get('companyId') !== actor.companyId || previous.get('senderId') !== 'user:' + actor.id || previous.get('text') !== text)
        throw new HttpsError('permission-denied', 'Announcement identity conflict');
      return { ok: true, messageId: message.id, duplicate: true };
    }
    tx.set(ref, { companyId: actor.companyId, permanent: true, broadcast: true, title: 'Dispatch Announcements' }, { merge: true });
    tx.create(message, { companyId: actor.companyId, text, senderId: 'user:' + actor.id, senderName: actor.name,
      timestamp: stamp(), createdAt: stamp(), clientId, recipientIds: roster.map(row => row.hash), recipients: roster });
    return { ok: true, messageId: message.id, duplicate: false };
  });
}
