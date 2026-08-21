import { evaluateAdminWriteWellConfig } from '../adminWriteWellConfig';

const lg = { companyId: 'liquid-gold', isPlatformAdmin: false };
const other = { companyId: 'acme-hauling', isPlatformAdmin: false };
const names = ['Gab 1', 'Python'];

describe('evaluateAdminWriteWellConfig', () => {
  it('allows liquid-gold add/update and forbids other tenants', () => {
    expect(evaluateAdminWriteWellConfig({
      op: 'add', wellName: 'AddedTest2', existingNames: names, caller: lg, record: { route: 'North' },
    }).ok).toBe(true);
    expect(evaluateAdminWriteWellConfig({
      op: 'add', wellName: 'AddedTest2', existingNames: names, caller: other, record: { route: 'North' },
    })).toEqual({ ok: false, reason: 'well_pool_forbidden' });
  });

  it('refuses history purge flags and unknown wells', () => {
    expect(evaluateAdminWriteWellConfig({
      op: 'deleteConfig', wellName: 'Gab 1', existingNames: names, caller: lg, record: { purgeHistory: true },
    })).toEqual({ ok: false, reason: 'history_purge_forbidden' });
    expect(evaluateAdminWriteWellConfig({
      op: 'update', wellName: 'Nope', existingNames: names, caller: lg, record: { route: 'X' },
    })).toEqual({ ok: false, reason: 'unknown_well' });
  });

  it('rename requires a free target name', () => {
    expect(evaluateAdminWriteWellConfig({
      op: 'rename', wellName: 'Gab 1', newName: 'Python', existingNames: names, caller: lg,
    })).toEqual({ ok: false, reason: 'well_exists' });
    expect(evaluateAdminWriteWellConfig({
      op: 'rename', wellName: 'Gab 1', newName: 'Gab 1-renamed', existingNames: names, caller: lg,
    }).ok).toBe(true);
  });
});
