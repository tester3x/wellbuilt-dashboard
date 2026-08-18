import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'requireDriverAuth.ts'), 'utf8');
const ingest = readFileSync(join(__dirname, '..', 'operational', 'packetIngest.ts'), 'utf8');

describe('legacy hash is rejected on operational endpoints', () => {
  it('requireSecureDriver rejects driverHash', () => {
    expect(src).toMatch(/legacy_hash_rejected/);
    expect(src).not.toMatch(/authSource: 'legacy_hash'/);
  });

  it('ingestDriverPacket is retired', () => {
    expect(ingest).toMatch(/ingestDriverPacket_retired_use_submitFieldCommand/);
  });
});
