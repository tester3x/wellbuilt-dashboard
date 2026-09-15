import {
  createDriverTransferRequest,
  resolveTransferRequest,
  acceptTransferRequest,
} from '../transferRequestOps';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Governed Transfer Operational Callables Contract', () => {
  const opsSrc = readFileSync(join(__dirname, '../transferRequestOps.ts'), 'utf8');

  it('exports all three governed transfer callables as Gen2 functions with run methods', () => {
    expect(createDriverTransferRequest).toBeDefined();
    expect(typeof (createDriverTransferRequest as any).run).toBe('function');

    expect(resolveTransferRequest).toBeDefined();
    expect(typeof (resolveTransferRequest as any).run).toBe('function');

    expect(acceptTransferRequest).toBeDefined();
    expect(typeof (acceptTransferRequest as any).run).toBe('function');
  });

  it('enforces verified server authentication (allowLegacyHash: false)', () => {
    expect(opsSrc).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
  });

  it('enforces Positive source-invoice ownership and company matching', () => {
    expect(opsSrc).toMatch(/Positive source-invoice ownership required/);
    expect(opsSrc).toMatch(/Ambiguous source-invoice ownership/);
    expect(opsSrc).toMatch(/Cross-company invoice transfer/);
  });

  it('enforces App Check policy consistency (enforceAppCheck: false staged for rollout)', () => {
    const matches = opsSrc.match(/enforceAppCheck: false/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(3); // All 3 callables
  });
});
