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
