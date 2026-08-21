import { evaluateCanonicalProvision } from '../staffProvisionCanonicalWbmDriver';

describe('canonical WB-M provision does not search legacy names', () => {
  it('requires display name and company and refuses a taken name-index', () => {
    expect(evaluateCanonicalProvision({
      displayName: 'NewTester',
      companyId: 'liquid-gold',
      nameIndexOwner: null,
    })).toEqual({ ok: true, scopeState: 'scope_not_configured' });
    expect(evaluateCanonicalProvision({
      displayName: 'Mikezfold',
      companyId: 'liquid-gold',
      nameIndexOwner: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
    })).toEqual({ ok: false, reason: 'name_taken' });
  });

  it('source never looks up drivers/approved by display name', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../staffProvisionCanonicalWbmDriverCallable.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/drivers\/approved/);
    expect(src).not.toMatch(/legacyHash/);
  });
});
