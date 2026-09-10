import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('VC96 runtime callable wiring', () => {
  const wellFn = read('src/security/operational/resolveWbtWellConfig.ts');
  const dispFn = read('src/security/operational/createDriverDispatchIfAbsent.ts');
  const acceptFn = read('src/security/operational/acceptDriverDispatch.ts');
  const ops = read('src/security/operational/index.ts');
  const security = read('src/security/index.ts');
  const index = read('src/index.ts');

  it('exports VC96 runtime callables through the existing security barrel', () => {
    expect(ops).toMatch(/export \{ resolveWbtWellConfig \} from '\.\/resolveWbtWellConfig'/);
    expect(ops).toMatch(/export \{ createDriverDispatchIfAbsent \} from '\.\/createDriverDispatchIfAbsent'/);
    expect(ops).toMatch(/export \{ acceptDriverDispatch \} from '\.\/acceptDriverDispatch'/);
    expect(security).toMatch(/resolveWbtWellConfig,/);
    expect(security).toMatch(/createDriverDispatchIfAbsent,/);
    expect(security).toMatch(/acceptDriverDispatch,/);
    expect(index).toMatch(/resolveWbtWellConfig,/);
    expect(index).toMatch(/createDriverDispatchIfAbsent,/);
    expect(index).toMatch(/acceptDriverDispatch,/);
  });

  it('resolveWbtWellConfig is auth-required, company from identity, no writes', () => {
    expect(wellFn).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    expect(wellFn).toMatch(/companyId: driver\.companyId/);
    expect(wellFn).toMatch(/Caller-selected company is ignored/);
    expect(wellFn).not.toMatch(/admin\.database\(\)\.ref\([^)]+\)\.(set|update|push)/);
    expect(wellFn).not.toMatch(/firestore\(\)[\s\S]{0,80}\.(set|create|update)/);
  });

  it('createDriverDispatchIfAbsent is transactional create-if-absent, no legacy hash', () => {
    expect(dispFn).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    expect(dispFn).toMatch(/runTransaction/);
    expect(dispFn).toMatch(/tx\.create/);
    expect(dispFn).not.toMatch(/allowLegacyHash: true/);
    expect(dispFn).toMatch(/already_exists/);
    expect(dispFn).toMatch(/Caller-selected company is ignored/);
  });

  it('acceptDriverDispatch is transactional pending/paused accept, no legacy hash, no merge-upsert', () => {
    expect(acceptFn).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    expect(acceptFn).toMatch(/runTransaction/);
    expect(acceptFn).toMatch(/tx\.update/);
    expect(acceptFn).not.toMatch(/allowLegacyHash: true/);
    expect(acceptFn).not.toMatch(/set\(d, \{ merge: true \}\)/);
    expect(acceptFn).toMatch(/already_accepted/);
  });
});
