import assert from 'node:assert/strict';
import test from 'node:test';
import { independentDriverContact } from '../independentDriverContact';
import type { IndependentDriverProfile } from '../independentDriverProfiles';
import type { ExternalDriver } from '../externalAssignmentDelivery';

const driver = { key: 'outside:driver-a', name: 'Official Driver Name' };
const roster = [{ externalDriverId: 'driver-a', phoneE164: '+17015550123' }] as ExternalDriver[];

test('share contact uses current profile details instead of the job snapshot or older roster phone', () => {
  const profiles = [{ driverKey: driver.key, phoneE164: '+17015550999', whatsappName: 'Driver in WhatsApp' }] as IndependentDriverProfile[];
  assert.deepEqual(independentDriverContact(driver, profiles, roster), {
    officialName: 'Official Driver Name', whatsappName: 'Driver in WhatsApp', phoneE164: '+17015550999',
  });
});

test('legacy outside roster phone is available until a profile explicitly clears it', () => {
  assert.equal(independentDriverContact(driver, [], roster).phoneE164, '+17015550123');
  assert.equal(independentDriverContact(driver, [{ driverKey: driver.key, phoneE164: '' }] as IndependentDriverProfile[], roster).phoneE164, '');
});

test('linked WellBuilt driver uses contact details saved in Independent Dispatch', () => {
  const linked = { key: 'wellbuilt:wb-marcial', name: 'Marcial Lebaron' };
  assert.deepEqual(independentDriverContact(linked,
    [{ driverKey: linked.key, phoneE164: '+17015550888', whatsappName: 'Marcial WA' }] as IndependentDriverProfile[], roster), {
    officialName: 'Marcial Lebaron', whatsappName: 'Marcial WA', phoneE164: '+17015550888',
  });
});
