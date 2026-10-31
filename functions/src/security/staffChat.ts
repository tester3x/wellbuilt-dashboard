import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { chatNameDirectory, realChatName, presentChatThread, presentChatMessage, UNKNOWN_CHAT_NAME } from './chatNames';

const key = (x: unknown): string => {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(x)) throw new https.HttpsError('invalid-argument', 'Invalid chat identifier');
  return x;
};
const serial = (value: any): any => value?.toDate instanceof Function ? value.toDate().toISOString()
  : Array.isArray(value) ? value.map(serial) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serial(v)])) : value;
const time = (value: any): number => value?.toMillis?.() || Date.parse(value || '') || 0;
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
async function directory(companyId: string): Promise<{ drivers: { hash: string; name: string }[]; aliases: Map<string, string>; names: Map<string, string> }> {
  const rt = admin.database();
  const [profiles, forward, reverse, approved, users] = await Promise.all([
    rt.ref('drivers/profiles').orderByChild('companyId').equalTo(companyId).once('value'),
    rt.ref('drivers/identityBindings/byDriver').once('value'), rt.ref('drivers/identityBindings/byApproved').once('value'),
    rt.ref('drivers/approved').orderByChild('companyId').equalTo(companyId).once('value'),
    rt.ref('users').orderByChild('companyId').equalTo(companyId).once('value'),
  ]);
  const byDriver = forward.val() || {}, byApproved = reverse.val() || {}, aliases = new Map<string, string>(), drivers: { hash: string; name: string }[] = [];
  for (const [id, value] of Object.entries(profiles.val() || {})) {
    const row = value as any;
    if (row.companyId !== companyId) continue;
    aliases.set(`driver:${id}`, `driver:${id}`);
    const binding = byDriver[id], back = byApproved[binding?.approvedKey];
    if (binding?.driverId === id && back?.driverId === id && back.approvedKey === binding.approvedKey && back.opId === binding.opId) aliases.set(`driver:${binding.approvedKey}`, `driver:${id}`);
    if (row.active !== false) drivers.push({ hash: id, name: '' });
  }
  const names = chatNameDirectory(companyId, profiles.val() || {}, approved.val() || {}, users.val() || {}, aliases);
  return { drivers: drivers.map(row => ({ ...row, name: names.get(`driver:${row.hash}`) || UNKNOWN_CHAT_NAME })), aliases, names };
}

export const staffChat = https.onCall({ timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false, invoker: 'public' }, async request => {
  const data = request.data || {}, action = data.action;
  const readActions = ['threads', 'messages', 'profiles', 'read', 'directory'];
  if (![...readActions, 'saveProfile', 'deleteProfile', 'send', 'direct', 'group', 'members', 'archive', 'broadcast', 'clear'].includes(action)) throw new https.HttpsError('invalid-argument', 'Unknown chat action');
  const staff = await requireTrustedCompanyCapability(request.auth?.uid,
    ['saveProfile', 'deleteProfile'].includes(action) ? 'manageCompany' : readActions.includes(action) ? 'viewChat' : 'sendChat');
  if (data.companyId && data.companyId !== staff.companyId) throw new https.HttpsError('permission-denied', 'Chat outside your company');
  const db = admin.firestore(), participant = `user:${staff.uid}`;
  const profile = (await admin.database().ref(`users/${staff.uid}`).once('value')).val();
  const identityDirectory = () => directory(staff.companyId);
  const senderDirectory = ['send', 'direct', 'group'].includes(action) ? await identityDirectory() : null;
  const name = realChatName(profile) || senderDirectory?.names.get(participant) || UNKNOWN_CHAT_NAME;
  if (action === 'directory') return { companyId: staff.companyId, drivers: (await directory(staff.companyId)).drivers };
  if (action === 'threads' || action === 'profiles') {
    const collection = action === 'threads' ? 'chat_threads' : 'chat_monitors';
    const snap = await db.collection(collection).where('companyId', '==', staff.companyId).get();
    let rows = snap.docs.map(doc => ({ ...doc.data(), id: doc.id } as Record<string, any>));
    if (action === 'threads') {
      const { aliases, names } = await identityDirectory();
      rows = rows.map(row => presentChatThread(row, names, aliases));
    } else {
      const { names } = await identityDirectory();
      rows = rows.map(row => ({ ...row, slots: (Array.isArray(row.slots) ? row.slots : []).map((slot: any) => slot?.driverHash
        ? { ...slot, driverName: names.get(`driver:${slot.driverHash}`) || UNKNOWN_CHAT_NAME } : slot) }));
    }
    if (data.ownOnly && action === 'threads') rows = rows.filter(row => row.participants?.includes(participant));
    rows.sort((a, b) => time(b.updatedAt || b.createdAt) - time(a.updatedAt || a.createdAt));
    return { companyId: staff.companyId, rows: serial(rows) };
  }
  if (action === 'direct' || action === 'group') {
    const targets: string[] = action === 'direct' ? [key(data.driverId)] : [...new Set<string>((data.driverIds || []).map(key))];
    if (!targets.length || targets.length > 50) throw new https.HttpsError('invalid-argument', 'Choose 1–50 drivers');
    const profiles = await Promise.all(targets.map(async id => {
      const row = (await admin.database().ref(`drivers/profiles/${id}`).once('value')).val();
      if (!row || row.active === false || row.companyId !== staff.companyId) throw new https.HttpsError('permission-denied', 'Driver outside your company');
      return { id, name: senderDirectory!.names.get(`driver:${id}`) || UNKNOWN_CHAT_NAME };
    }));
    const participants = [participant, ...targets.map(id => `driver:${id}`)].sort();
    const title = action === 'direct' ? profiles[0].name : String(data.title || '').trim().slice(0, 120);
    if (!title) throw new https.HttpsError('invalid-argument', 'Chat title required');
    const type = action === 'direct' ? 'direct' : data.type;
    if (!['direct', 'service_group', 'project', 'well'].includes(type)) throw new https.HttpsError('invalid-argument', 'Invalid thread type');
    if (action === 'direct') {
      const { aliases } = senderDirectory!;
      const old = await db.collection('chat_threads').where('companyId', '==', staff.companyId).where('participants', 'array-contains', participant).get();
      const match = old.docs.find(doc => doc.get('type') === 'direct' && doc.get('participants')?.some((id: string) => (aliases.get(id) || id) === `driver:${targets[0]}`));
      if (match) { await match.ref.update({ status: 'active', updatedAt: stamp() }); return { ok: true, threadId: match.id }; }
    }
    const id = action === 'direct' ? 'direct_' + createHash('sha256').update(staff.companyId + ':' + participants.join('|')).digest('hex') : key(data.requestId);
    const ref = db.collection('chat_threads').doc(id);
    await db.runTransaction(async tx => {
      const old = await tx.get(ref);
      if (old.exists) {
        if (old.get('companyId') !== staff.companyId || !old.get('participants')?.includes(participant)) throw new https.HttpsError('permission-denied', 'Thread identity conflict');
        return;
      }
      tx.create(ref, { companyId: staff.companyId, type, title, participants, participantIds: targets,
        participantNames: { [participant]: name, ...Object.fromEntries(profiles.map(p => [`driver:${p.id}`, p.name])) },
        directPair: participants.join('_'), broadcast: data.broadcast === true, status: 'active', createdAt: stamp(), updatedAt: stamp(), lastRead: {} });
      if (action === 'group') tx.create(ref.collection('messages').doc('created'), { text: `${name} created "${title}"`, senderId: 'system', senderName: 'System', type: 'system', timestamp: stamp(), createdAt: stamp() });
    });
    return { ok: true, threadId: id };
  }
  if (action === 'saveProfile' || action === 'deleteProfile') {
    const id = key(data.profileId), ref = db.collection('chat_monitors').doc(id), old = await ref.get();
    if (old.exists && old.get('companyId') !== staff.companyId) throw new https.HttpsError('permission-denied', 'Monitor outside your company');
    if (action === 'deleteProfile') { if (old.exists) await ref.delete(); return { ok: true }; }
    const fields: Record<string, any> = {};
    for (const k of ['name', 'gridLayout', 'threadType', 'locked', 'slots']) if (data.record?.[k] !== undefined) fields[k] = data.record[k];
    if (fields.name && (typeof fields.name !== 'string' || fields.name.length > 120)) throw new https.HttpsError('invalid-argument', 'Invalid monitor name');
    if (fields.gridLayout && !/^([1-6])x([1-6])$/.test(fields.gridLayout)) throw new https.HttpsError('invalid-argument', 'Invalid grid');
    if (fields.slots) {
      if (!Array.isArray(fields.slots) || fields.slots.length > 36) throw new https.HttpsError('invalid-argument', 'Invalid monitor slots');
      for (const slot of fields.slots) if (slot) {
        if (slot.threadId) {
          const thread = await db.collection('chat_threads').doc(key(slot.threadId)).get();
          if (!thread.exists || thread.get('companyId') !== staff.companyId) throw new https.HttpsError('permission-denied', 'Monitor thread outside your company');
        }
        if (slot.driverHash) {
          const driver = (await admin.database().ref(`drivers/profiles/${key(slot.driverHash)}`).once('value')).val();
          if (!driver || driver.companyId !== staff.companyId) throw new https.HttpsError('permission-denied', 'Monitor driver outside your company');
        }
      }
    }
    await ref.set({ ...fields, companyId: staff.companyId, createdBy: staff.uid, updatedAt: stamp(), ...(!old.exists ? { createdAt: stamp() } : {}) }, { merge: true });
    return { ok: true, profileId: id };
  }
  const threadId = key(data.threadId), ref = db.collection('chat_threads').doc(threadId), snapshot = await ref.get();
  if (!snapshot.exists || snapshot.get('companyId') !== staff.companyId) throw new https.HttpsError('permission-denied', 'Thread outside your company');
  if (action === 'members') {
    if (snapshot.get('type') === 'direct' || !Array.isArray(data.driverIds) || data.driverIds.length > 50) throw new https.HttpsError('invalid-argument', 'Invalid group members');
    const ids = [...new Set<string>(data.driverIds.map(key))];
    const names: Record<string, string> = {};
    for (const id of ids) {
      const row = (await admin.database().ref(`drivers/profiles/${id}`).once('value')).val();
      if (!row || row.active === false || row.companyId !== staff.companyId) throw new https.HttpsError('permission-denied', 'Driver outside your company');
      names[`driver:${id}`] = realChatName(row) || UNKNOWN_CHAT_NAME;
    }
    await db.runTransaction(async tx => {
      const latest = await tx.get(ref);
      if (latest.get('companyId') !== staff.companyId || latest.get('type') === 'direct') throw new https.HttpsError('permission-denied', 'Thread changed');
      const staffMembers = (latest.get('participants') || []).filter((id: string) => id.startsWith('user:'));
      const oldNames = latest.get('participantNames') || {};
      for (const member of staffMembers) names[member] = oldNames[member] || 'Dispatch';
      tx.update(ref, { participants: [...staffMembers, ...ids.map(id => `driver:${id}`)], participantIds: ids, participantNames: names, updatedAt: stamp() });
    });
    return { ok: true };
  }
  if (action === 'read') { await ref.update({ [`lastRead.${participant}`]: stamp() }); return { ok: true }; }
  if (action === 'archive') { await ref.update({ status: data.archived === false ? 'active' : 'archived', updatedAt: stamp() }); return { ok: true }; }
  if (action === 'broadcast') { await ref.update({ broadcast: data.broadcast === true, updatedAt: stamp() }); return { ok: true }; }
  if (action === 'clear') { await ref.update({ [`clearedBefore.${participant}`]: stamp() }); return { ok: true }; }
  if (action === 'messages') {
    const batches = await Promise.all(['timestamp', 'createdAt'].map(field => ref.collection('messages').orderBy(field, 'desc').limit(200).get()));
    const rows = new Map<string, any>(), cleared = time(snapshot.get('clearedBefore')?.[participant]);
    for (const batch of batches) for (const doc of batch.docs) {
      const row = doc.data(), timestamp = row.timestamp || row.createdAt;
      if (time(timestamp) > cleared) rows.set(doc.id, { ...row, id: doc.id, timestamp, type: row.type || 'text' });
    }
    const { names } = await identityDirectory();
    return { rows: serial([...rows.values()].sort((a, b) => time(a.timestamp) - time(b.timestamp)).map(row => presentChatMessage(row, names))) };
  }
  const clientId = key(data.clientId), text = String(data.text || '').trim();
  if (!text || text.length > 4000) throw new https.HttpsError('invalid-argument', 'Message must contain 1–4000 characters');
  const message = ref.collection('messages').doc(`c_${clientId}`);
  return db.runTransaction(async tx => {
    const [thread, previous] = await Promise.all([tx.get(ref), tx.get(message)]);
    if (thread.get('companyId') !== staff.companyId) throw new https.HttpsError('permission-denied', 'Thread company changed');
    if (previous.exists) {
      if (previous.get('senderId') !== participant || previous.get('text') !== text) throw new https.HttpsError('permission-denied', 'Message identity conflict');
      return { ok: true, messageId: message.id, duplicate: true };
    }
    const preview = { text, senderId: participant, senderName: name, timestamp: stamp(), type: 'text' };
    tx.create(message, { ...preview, createdAt: stamp(), clientId });
    tx.update(ref, { lastMessage: preview, updatedAt: stamp(), [`lastRead.${participant}`]: stamp() });
    return { ok: true, messageId: message.id };
  });
});
