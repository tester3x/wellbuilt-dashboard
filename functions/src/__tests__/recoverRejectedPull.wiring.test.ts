// Wiring proof: the recovery callable is authored + registered (re-exported
// from index.ts, the Functions entrypoint). Source-assertion — no admin load.
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('recoverRejectedPull — callable registration', () => {
  const index = read('index.ts');
  const wrapper = read('recoverRejectedPullCallable.ts');

  test('index.ts re-exports recoverRejectedPull (deployable registration)', () => {
    expect(index).toMatch(/export\s*\{\s*recoverRejectedPull\s*\}\s*from\s*'\.\/recoverRejectedPullCallable'/);
  });

  test('the callable is an authenticated onCall requiring a secure driver', () => {
    expect(wrapper).toMatch(/httpsV2\.onCall/);
    expect(wrapper).toMatch(/requireSecureDriver\(request\)/);
    expect(wrapper).toMatch(/assertSameCompany/);
    expect(wrapper).toMatch(/assertDriverOwns/);
  });

  test('the wrapper drives the pure runner and uses transactional claim + no-overwrite incoming', () => {
    expect(wrapper).toMatch(/executeRecovery\(io, input/);
    expect(wrapper).toMatch(/recoveryClaim`\)\s*;?[\s\S]{0,120}\.transaction\(/);
    expect(wrapper).toMatch(/never overwrite an in-flight incoming packet/);
  });
});
