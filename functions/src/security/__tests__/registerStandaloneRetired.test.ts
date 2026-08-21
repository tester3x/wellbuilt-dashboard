import { decideStandaloneRegistration } from '../driverAuthCallables';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('registerStandaloneDriver is fail-closed', () => {
  it('never returns ok and never names an active write', () => {
    expect(decideStandaloneRegistration()).toEqual({
      ok: false,
      code: 'failed-precondition',
      message: 'registerStandaloneDriver_retired_use_requestDriverRegistration',
    });
  });

  it('source does not create credentials, profiles, name index, or Auth users', () => {
    const src = readFileSync(join(__dirname, '..', 'driverAuthCallables.ts'), 'utf8');
    const stand = src.slice(src.indexOf('export const registerStandaloneDriver'));
    const body = stand.slice(0, stand.indexOf('export const adminComputeLegacyHash'));
    expect(body).not.toMatch(/driver_name_index/);
    expect(body).not.toMatch(/driver_credentials/);
    expect(body).not.toMatch(/drivers\/profiles/);
    expect(body).not.toMatch(/ensureDriverAuthUser/);
    expect(body).not.toMatch(/mintDriverSessionTokens/);
    expect(body).not.toMatch(/active:\s*true/);
    expect(src).toContain('export const requestDriverRegistration');
  });
});
