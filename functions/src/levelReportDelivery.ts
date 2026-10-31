import { CONVERSATIONS, ensureConversation, validConversation } from './security/dispatchConversations';
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';
import { createHash } from 'crypto';
import { realChatName, UNKNOWN_CHAT_NAME } from './security/chatNames';
import { logicalPullId } from './security/operational/crossKeyPullClaim';

type Row = Record<string, any>;
export type LevelChatDeps = {
  read(path: string): Promise<Row | null>;
  company(id: string): Promise<Row | null>;
  threads(companyId: string, driverId: string, driverName: string): Promise<{ id: string; row: Row }[]>;
  writeOnce(threadId: string, messageId: string, companyId: string, driverKeys: string[], message: Row): Promise<void>;
};
const id = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : '';
const companyId = (row: Row | null): string => id(row?.companyId);
const level = (inches: number): string => {
  const whole = Math.max(0, Math.round(inches));
  return `${Math.floor(whole / 12)}'${whole % 12}\"`;
};
function reciprocal(driverId: string, approvedKey: string, forward: Row | null, reverse: Row | null): boolean {
  return !!forward?.opId && forward.driverId === driverId && reverse?.driverId === driverId &&
    forward.approvedKey === approvedKey && reverse.approvedKey === approvedKey && forward.opId === reverse.opId;
}

export async function resolveLevelChatDriver(packet: Row, deps: LevelChatDeps): Promise<{ driverId: string; companyId: string; keys: string[]; name: string } | null> {
  const supplied = id(packet.driverId);
  if (!supplied) return null; // Never infer membership from a name, well or truck.
  let canonical = supplied, profile = await deps.read(`drivers/profiles/${supplied}`);
  const keys = new Set([supplied]);
  if (!profile) {
    const reverse = await deps.read(`drivers/identityBindings/byApproved/${supplied}`);
    const target = id(reverse?.driverId);
    if (target) {
      const forward = await deps.read(`drivers/identityBindings/byDriver/${target}`);
      if (reciprocal(target, supplied, forward, reverse)) {
        profile = await deps.read(`drivers/profiles/${target}`);
        canonical = target; keys.add(target);
      }
    }
  }
  if (profile) {
    const forward = await deps.read(`drivers/identityBindings/byDriver/${canonical}`);
    const legacy = id(forward?.approvedKey);
    if (legacy) {
      const reverse = await deps.read(`drivers/identityBindings/byApproved/${legacy}`);
      if (reciprocal(canonical, legacy, forward, reverse)) keys.add(legacy);
    }
  } else {
    // Exact legacy key only; no fuzzy matching or name-based authority.
    profile = await deps.read(`drivers/approved/${supplied}`);
  }
  const company = companyId(profile);
  if (!company || (packet.companyId && packet.companyId !== company)) return null;
  return { driverId: canonical, companyId: company, keys: [...keys], name: realChatName(profile) || UNKNOWN_CHAT_NAME };
}

export function levelReportText(packet: Row, settings: Row, driverName: string): string | null {
  const top = Number(packet.tankTopInches ?? Number(packet.tankLevelFeet) * 12);
  const bottom = Number(packet.tankAfterInches);
  const bbls = Number(packet.bblsTaken);
  if (packet.noLevel || !Number.isFinite(top) || top <= 0 || packet.tankAfterInches == null ||
      !Number.isFinite(bottom) || !Number.isFinite(bbls) || bbls < 0 || !packet.wellName) return null;
  const date = new Date(packet.dateTimeUTC);
  if (!Number.isFinite(date.getTime())) return null;
  let zone = packet.timezone || settings.timezone || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(date); } catch { zone = 'America/Chicago'; }
  const values: Record<string, string> = {
    well: String(packet.wellName), wellName: String(packet.wellName), top: level(top), bottom: level(bottom),
    bbls: String(bbls), driverName,
    date: date.toLocaleDateString('en-US', { timeZone: zone, month: '2-digit', day: '2-digit', year: 'numeric' }),
    time: date.toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }),
  };
  const template = typeof settings.levelReportTemplate === 'string' && settings.levelReportTemplate.trim()
    ? settings.levelReportTemplate : '{well}\nTop: {top} | Bottom: {bottom}\n{bbls} BBL · {time}';
  return template.replace(/\{(wellName|well|top|bottom|bbls|driverName|date|time)\}/gi,
    (_, key: string) => values[Object.keys(values).find(k => k.toLowerCase() === key.toLowerCase())!]).slice(0, 4000);
}

export function isLevelChatRecipient(row: Row, company: string, driverKeys: string[]): boolean {
  const members = Array.isArray(row.participants) ? row.participants : [];
  return row.companyId === company && row.type === 'direct' && row.audience === 'dispatch_team' && row.broadcast !== true &&
    members.some((p: string) => driverKeys.some(key => p === `driver:${key}`));
}

export function levelReportMessageId(packetId: string, company: string, driverId: string): string {
  return 'level_' + createHash('sha256').update(JSON.stringify([company, driverId, logicalPullId(packetId)])).digest('hex');
}

export async function deliverLevelReport(packet: Row, packetId: string, deps = productionLevelChatDeps()): Promise<{ result: string; recipients?: number }> {
  const driver = await resolveLevelChatDriver(packet, deps);
  if (!driver) return { result: 'unresolved_driver' };
  const settings = await deps.company(driver.companyId);
  if (settings?.sendLevelToDispatch !== true) return { result: 'disabled' };
  const text = levelReportText(packet, settings, driver.name);
  if (!text) return { result: 'no_measured_level' };
  const threads = (await deps.threads(driver.companyId, driver.driverId, driver.name)).filter(t => isLevelChatRecipient(t.row, driver.companyId, driver.keys));
  // Thread creation can race packet processing. Retry the event rather than lose the report.
  if (!threads.length) throw new Error('level_chat_recipient_not_ready');
  const messageId = levelReportMessageId(packetId, driver.companyId, driver.driverId);
  const message = { text, senderId: `driver:${driver.driverId}`, senderName: driver.name,
    type: 'level_report', systemType: 'level_report', clientId: messageId,
    sourcePacketId: logicalPullId(packetId), measuredAtUTC: packet.dateTimeUTC };
  for (const thread of threads) await deps.writeOnce(thread.id, messageId, driver.companyId, driver.keys, message);
  return { result: 'delivered', recipients: threads.length };
}

export function productionLevelChatDeps(): LevelChatDeps {
  const db = admin.firestore();
  return {
    read: async path => (await admin.database().ref(path).once('value')).val(),
    company: async company => (await db.collection('companies').doc(company).get()).data() || null,
    threads: async (company, driver, name) => {
      const id = await ensureConversation(company, driver, name);
      const snapshot = await db.collection(CONVERSATIONS).doc(id).get();
      return [{ id, row: snapshot.data()! }];
    },
    writeOnce: async (threadId, messageId, company, keys, message) => {
      const thread = db.collection(CONVERSATIONS).doc(threadId), target = thread.collection('messages').doc(messageId);
      await db.runTransaction(async tx => {
        const [current, previous] = await Promise.all([tx.get(thread), tx.get(target)]);
        if (!current.exists || !validConversation(current.data(), threadId) || !isLevelChatRecipient(current.data()!, company, keys)) throw new Error('level_chat_recipient_changed');
        if (previous.exists) {
          if (previous.get('sourcePacketId') !== message.sourcePacketId || previous.get('senderId') !== message.senderId) {
            throw new Error('level_chat_identity_conflict');
          }
          return; // A retry must not replace a newer human-message preview.
        }
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        tx.create(target, { ...message, timestamp, createdAt: timestamp });
        tx.update(thread, { lastMessage: { text: message.text.slice(0, 100), senderId: message.senderId,
          senderName: message.senderName, timestamp, type: 'system' }, updatedAt: timestamp, lastMessageAt: timestamp });
      });
    },
  };
}

/** Independent of app lifetime and the incoming processor's acknowledgement. */
export const deliverProcessedLevelReport = functions.runWith({ timeoutSeconds: 120, memory: '256MB', failurePolicy: true })
  .database.ref('packets/processed/{packetId}').onCreate(async (snapshot, context) => {
    const packet = snapshot.val() || {};
    // Safe rolling activation: old in-flight processors still emit random-ID
    // reports. Only the new producer shares this worker's stable message ID.
    if (packet.levelReportDeliveryVersion !== 2) return;
    const outcome = await deliverLevelReport(packet, context.params.packetId);
    console.log('[LevelChatDelivery]', outcome);
  });
