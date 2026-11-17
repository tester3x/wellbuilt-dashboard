import * as admin from 'firebase-admin';
import {createHash} from 'crypto';

export function messageReservationKey(channel: string, messageId: string, rowIndex: number) {
  return createHash('sha256').update(JSON.stringify([channel, messageId, rowIndex])).digest('hex');
}

export function assertSameMessageDelivery(previous: any, identity: string, packetId: string) {
  if (previous && (previous.identity !== identity || previous.packetId !== packetId)) {
    throw Error('message_already_reserved_for_another_delivery');
  }
}

// Called inside the same transaction that creates the delivery. A retry cannot
// reserve another observation identity by changing its OCR or reviewed values.
export async function reserveMessage(tx: admin.firestore.Transaction, input: {
  channel: string; messageId: string; rowIndex: number; identity: string; packetId: string;
}) {
  const fs = admin.firestore();
  const ref = fs.doc('watchdog_message_deliveries/' + messageReservationKey(input.channel, input.messageId, input.rowIndex));
  const previous = (await tx.get(ref)).data();
  assertSameMessageDelivery(previous, input.identity, input.packetId);
  const messageHash = createHash('sha256').update(input.channel + ':' + input.messageId).digest('hex');
  const legacy = await tx.get(fs.collection('watchdog_v2_deliveries').where('messageHash', '==', messageHash));
  for (const doc of legacy.docs) {
    const entry = doc.data();
    if (entry.rowIndex === input.rowIndex || entry.rowIndex === undefined) {
      assertSameMessageDelivery(entry, input.identity, input.packetId);
    }
  }
  if (!previous) tx.create(ref, {messageHash, rowIndex: input.rowIndex, identity: input.identity,
    packetId: input.packetId, companyId: 'liquid-gold', createdAt: Date.now()});
}
