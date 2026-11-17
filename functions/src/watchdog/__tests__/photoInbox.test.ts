jest.mock('../intake', () => ({authenticate: jest.fn()}));
jest.mock('../remoteReview', () => ({authorizeWatchdogOffice: jest.fn()}));
import {photoMessageKey, validatePhotoSnapshot} from '../photoInbox';

const photo = {channel: 'watched-group', messageId: 'original-whatsapp-id', imageDigest: 'a'.repeat(64),
  mimeType: 'image/jpeg', bytes: 200, caption: 'Dwyer', postedAt: '2026-11-01T00:00:00Z', rows: []};

test('photo key uses source message identity independently of OCR values', () => {
  expect(validatePhotoSnapshot(photo)).toBe(validatePhotoSnapshot({...photo, rows: [{bottomLevelFeet: 7.7}]}));
  expect(photoMessageKey('another-group', photo.messageId)).not.toBe(validatePhotoSnapshot(photo));
});

test.each([{mimeType: 'text/html'}, {bytes: 13 * 1024 * 1024}, {imageDigest: '../other-object'}, {postedAt: 'invalid'}, {messageId: 123}])('rejects invalid photo metadata %j', change => {
  expect(() => validatePhotoSnapshot({...photo, ...change})).toThrow();
});
