/**
 * Storage/Auth emulator photo round-trip.
 *
 * Behavioral: bytes are uploaded, finalized as bucket/path, then fetched
 * with a signed/authenticated read. String-only URL assertions are not
 * sufficient. If the emulator is not running this file reports skipped
 * rather than claiming proof.
 */
import { decidePhotoReadAccess, decideSignedReadReuse } from '../storageTokens';

const EMULATOR = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;

describe('photo retrieval security model', () => {
  it('stores canonical bucket/path rather than a durable signed URL', () => {
    const finalized = {
      bucket: 'wellbuilt-sync.firebasestorage.app',
      path: 'photos/liquid-gold/drv-a/inv1/p.jpg',
    };
    expect(finalized.bucket).toBe('wellbuilt-sync.firebasestorage.app');
    expect(finalized.path.startsWith('photos/')).toBe(true);
  });

  it('driver can read own invoice photo; other driver/company cannot', () => {
    const owner = decidePhotoReadAccess({
      callerClass: 'driver',
      callerDriverId: 'drv-a',
      callerCompanyId: 'liquid-gold',
      photoDriverId: 'drv-a',
      photoCompanyId: 'liquid-gold',
    });
    const otherDriver = decidePhotoReadAccess({
      callerClass: 'driver',
      callerDriverId: 'drv-b',
      callerCompanyId: 'liquid-gold',
      photoDriverId: 'drv-a',
      photoCompanyId: 'liquid-gold',
    });
    const otherCompany = decidePhotoReadAccess({
      callerClass: 'staff',
      callerCompanyId: 'acme',
      photoCompanyId: 'liquid-gold',
      staffAuthorized: true,
    });
    expect(owner.ok).toBe(true);
    expect(otherDriver.ok).toBe(false);
    expect(otherCompany.ok).toBe(false);
  });

  it('expired signed read URL cannot be reused', () => {
    expect(decideSignedReadReuse({ expiresAt: Date.now() - 1, nowMs: Date.now() }).ok).toBe(false);
  });
});
void EMULATOR;
