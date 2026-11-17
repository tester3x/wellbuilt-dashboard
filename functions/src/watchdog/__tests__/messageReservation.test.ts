import {assertSameMessageDelivery, messageReservationKey} from '../messageReservation';

test('message identity is stable and separates channels and rows', () => {
  expect(messageReservationKey('a', 'm', 0)).toBe(messageReservationKey('a', 'm', 0));
  expect(messageReservationKey('a', 'm', 0)).not.toBe(messageReservationKey('b', 'm', 0));
  expect(messageReservationKey('a', 'm', 0)).not.toBe(messageReservationKey('a', 'm', 1));
});

test('retry accepts its original delivery and rejects changed parsed values', () => {
  expect(() => assertSameMessageDelivery(undefined, 'observation', 'packet')).not.toThrow();
  expect(() => assertSameMessageDelivery({identity: 'observation', packetId: 'packet'}, 'observation', 'packet')).not.toThrow();
  expect(() => assertSameMessageDelivery({identity: 'original', packetId: 'packet'}, 'new-ocr-values', 'new-packet')).toThrow('message_already_reserved');
});
