import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';
import { createHash } from 'crypto';
import { consolidateDispatchHistory, CONVERSATIONS, validConversation } from './dispatchConversations';
import { realChatName, UNKNOWN_CHAT_NAME } from './chatNames';

const ms = (value: any): number => value?.toMillis?.() || (typeof value === 'string' ? Date.parse(value) : 0) || 0;

/** Stable per-shift events in the same governed conversation used by level reports. */
export async function postShiftDispatchNotice(shift: any, shiftId: string, kind: 'shift_started' | 'shift_ended', fallback: any): Promise<string | null> {
  const rawId = shift?.driverId || shift?.driverHash, company = shift?.companyId;
  if (typeof rawId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(rawId) || typeof company !== 'string' || !company) return null;
  const rt = admin.database();
  let id = rawId, profile = (await rt.ref(`drivers/profiles/${id}`).once('value')).val();
  if (!profile) {
    const reverse = (await rt.ref(`drivers/identityBindings/byApproved/${rawId}`).once('value')).val();
    if (!reverse?.driverId) return null;
    const forward = (await rt.ref(`drivers/identityBindings/byDriver/${reverse.driverId}`).once('value')).val();
    if (forward?.approvedKey !== rawId || forward.driverId !== reverse.driverId || forward.opId !== reverse.opId) return null;
    id = reverse.driverId;
    profile = (await rt.ref(`drivers/profiles/${id}`).once('value')).val();
  }
  if (!profile || profile.active !== true || profile.companyId !== company) return null;
  const keys = [id], binding = (await rt.ref(`drivers/identityBindings/byDriver/${id}`).once('value')).val();
  if (binding?.driverId === id && typeof binding.approvedKey === 'string') {
    const back = (await rt.ref(`drivers/identityBindings/byApproved/${binding.approvedKey}`).once('value')).val();
    if (back?.driverId === id && back.approvedKey === binding.approvedKey && back.opId === binding.opId) keys.push(binding.approvedKey);
  }
  const name = realChatName(profile) || UNKNOWN_CHAT_NAME;
  const threadId = await consolidateDispatchHistory(company, id, name, keys);
  const ref = admin.firestore().collection(CONVERSATIONS).doc(threadId);
  const messageId = kind + '_' + createHash('sha256').update(shiftId).digest('hex');
  const message = ref.collection('messages').doc(messageId);
  const eventTime = ms(kind === 'shift_started' ? shift.loginAt || shift.startedAt : shift.logoutAt || shift.endedAt) || ms(fallback) || Date.now();
  const timestamp = admin.firestore.Timestamp.fromMillis(eventTime);
  await admin.firestore().runTransaction(async tx => {
    const [thread, previous] = await Promise.all([tx.get(ref), tx.get(message)]);
    if (!validConversation(thread.data(), threadId)) throw new Error('Shift dispatch conversation changed');
    if (previous.exists) return;
    const text = `${name} ${kind === 'shift_started' ? 'came on shift' : 'went off shift'}`;
    const row = { text, senderId: `driver:${id}`, senderName: name, type: 'system', systemType: kind,
      systemData: { driverName: name, shiftId }, timestamp, createdAt: timestamp };
    tx.create(message, row);
    if (eventTime > ms(thread.get('lastMessage')?.timestamp)) tx.update(ref, {
      lastMessage: { text, senderId: row.senderId, senderName: name, type: 'system', timestamp }, updatedAt: timestamp,
    });
  });
  return threadId;
}

export const onShiftCreate = functions.firestore.document('driver_shifts/{shiftId}').onCreate(async (snapshot, context) => {
  await postShiftDispatchNotice(snapshot.data(), context.params.shiftId, 'shift_started', snapshot.createTime);
});

export const onShiftUpdate = functions.firestore.document('driver_shifts/{shiftId}').onUpdate(async (change, context) => {
  const before = change.before.data(), after = change.after.data();
  if ((!before.logoutAt && after.logoutAt) || (!before.endedAt && after.endedAt)) {
    await postShiftDispatchNotice(after, context.params.shiftId, 'shift_ended', change.after.updateTime);
  }
});
