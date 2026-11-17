import * as admin from 'firebase-admin';
import * as https from 'firebase-functions/v2/https';
import {createHash} from 'crypto';
import {authenticate} from './intake';
import {authorizeWatchdogOffice} from './remoteReview';

const companyId = 'liquid-gold';
const collection = 'watchdog_photo_inbox/' + companyId + '/items';
const maxBytes = 12 * 1024 * 1024;
const mimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export function photoMessageKey(channel: string, messageId: string) {
  if (typeof channel !== 'string' || !channel || channel.length > 200 || typeof messageId !== 'string' || !messageId || messageId.length > 500) throw Error('invalid_message_identity');
  // Matches the messageHash already stored on Watchdog delivery receipts.
  return sha(channel + ':' + messageId);
}

export function validatePhotoSnapshot(body: any) {
  const messageHash = photoMessageKey(body?.channel, body?.messageId);
  if (!/^[a-f0-9]{64}$/.test(body.imageDigest) || !mimeTypes.has(body.mimeType) ||
      !Number.isInteger(body.bytes) || body.bytes < 1 || body.bytes > maxBytes ||
      typeof body.caption !== 'string' || body.caption.length > 6000 ||
      !Number.isFinite(Date.parse(body.postedAt)) || !Array.isArray(body.rows) ||
      body.rows.length > 10 || JSON.stringify(body.rows).length > 6000) throw Error('invalid_photo_snapshot');
  return messageHash;
}

async function matchingReceipts(messageHash: string) {
  const deliveries = await admin.firestore().collection('watchdog_v2_deliveries').where('messageHash', '==', messageHash).get();
  const receipts = await Promise.all(deliveries.docs.map(async doc => {
    const entry = doc.data();
    const packet = (await admin.database().ref('packets/processed/' + entry.packetId).once('value')).val();
    return {identity: doc.id, packetId: entry.packetId, wellName: entry.wellName,
      recorded: !!packet && packet.source === 'whatsapp_watchdog' && packet.packetId === entry.packetId &&
        packet.watchdogProvenance?.observationDigest === doc.id,
      bottomFeet: packet ? Number(packet.tankAfterInches) / 12 : null, bbls: packet?.bblsTaken ?? null};
  }));
  const recordedCount = new Set(receipts.filter(item => item.recorded).map(item => item.packetId)).size;
  return {receipts, recordedCount, status: recordedCount === 1 ? 'recorded_once' : recordedCount > 1 ? 'duplicate_attention' : receipts.length ? 'delivery_unconfirmed' : 'no_message_receipt'};
}

export const syncWatchdogPhotoInboxV2 = https.onRequest({region: 'us-central1', timeoutSeconds: 60, secrets: ['WATCHDOG_HMAC_KEY_V1']}, async (req, res) => {
  try {
    await authenticate(req, 'syncWatchdogPhotoInboxV2');
    const body = req.body;
    const messageHash = validatePhotoSnapshot(body);
    const policy = (await admin.firestore().doc('watchdog_v2_config/laptop').get()).data();
    if (!policy?.enabled || !policy.channels?.[body.channel]) throw Error('channel_not_allowed');
    const ref = admin.firestore().doc(collection + '/' + messageHash);
    const objectPath = 'watchdog-review-photos/' + companyId + '/' + messageHash + '/' + body.imageDigest;
    await admin.firestore().runTransaction(async tx => {
      const previous = (await tx.get(ref)).data();
      if (previous && (previous.messageId !== body.messageId || previous.channel !== body.channel || previous.imageDigest !== body.imageDigest)) throw Error('photo_identity_conflict');
      tx.set(ref, {companyId, messageHash, channel: body.channel, messageId: body.messageId,
        imageDigest: body.imageDigest, mimeType: body.mimeType, bytes: body.bytes,
        objectPath, caption: body.caption, postedAt: body.postedAt, rows: body.rows,
        updatedAt: Date.now(), createdAt: previous?.createdAt ?? Date.now()}, {merge: true});
    });
    const file = admin.storage().bucket().file(objectPath);
    if (body.complete === true) {
      const [metadata] = await file.getMetadata();
      if (Number(metadata.size) !== body.bytes || metadata.contentType !== body.mimeType) throw Error('photo_upload_mismatch');
      const [contents] = await file.download({validation: 'crc32c'});
      if (createHash('sha256').update(contents).digest('hex') !== body.imageDigest) throw Error('photo_digest_mismatch');
      await ref.update({photoReady: true});
      res.json({ok: true, messageHash, ...await matchingReceipts(messageHash)});
      return;
    }
    const [uploadUrl] = await file.getSignedUrl({version: 'v4', action: 'write', expires: Date.now() + 10 * 60 * 1000, contentType: body.mimeType,
      extensionHeaders: {'x-goog-if-generation-match': '0'}});
    res.json({ok: true, messageHash, uploadUrl});
  } catch (error) {
    res.status(400).json({ok: false, error: String((error as Error).message).slice(0, 300)});
  }
});

export const listWatchdogPhotoInbox = https.onCall({region: 'us-central1', timeoutSeconds: 120}, async request => {
  const scope = await authorizeWatchdogOffice(request);
  const snapshot = await admin.firestore().collection('watchdog_photo_inbox/' + scope + '/items').orderBy('postedAt', 'desc').limit(50).get();
  const rows = await Promise.all(snapshot.docs.map(async doc => {
    const item = doc.data();
    let photoUrl: string | null = null;
    if (item.photoReady) [photoUrl] = await admin.storage().bucket().file(item.objectPath).getSignedUrl({version: 'v4', action: 'read', expires: Date.now() + 10 * 60 * 1000});
    return {id: doc.id, ...item, photoUrl, ...await matchingReceipts(item.messageHash)};
  }));
  return {rows, truncated: snapshot.size === 50};
});
