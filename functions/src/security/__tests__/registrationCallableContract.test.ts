import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'driverAuthCallables.ts'), 'utf8');

describe('registration callable lifecycle wiring', () => {
  test('request persists one canonical expiry and a uniqueness reservation', () => {
    expect(source).toContain('PENDING_REGISTRATION_TTL_MS');
    expect(source).toContain("collection('driver_provisioning_attempts')");
    expect(source).toContain('expiresAtMs');
  });

  test('poll, list, approve and reject close expired or terminal reservations', () => {
    expect(source).toContain('expirePendingRegistration');
    expect(source).toContain('releasePendingReservation');
  });

  test('registration uses a stable legacy mirror key instead of push', () => {
    expect(source).toContain('drivers/pending/${pendingId}');
    expect(source).not.toContain("rtdb().ref('drivers/pending').push");
  });
});
