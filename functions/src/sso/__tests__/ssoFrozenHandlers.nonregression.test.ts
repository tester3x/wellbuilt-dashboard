/**
 * Pins the existing Dashboard SSO handlers. WB-M may be added as another
 * audience; these names, WBT/equipment predicates, and the 0.4.0 mirror
 * must not be rewritten as cleanup.
 */
import {
  SSO_AUDIENCE_EQUIPMENT,
  SSO_AUDIENCE_WBT,
  isSsoAudience,
  audienceRequiresShiftBinding,
  SSO_SESSION_APP_BY_AUDIENCE,
} from '@tester3x/wellbuilt-contracts';
import { readFileSync } from 'fs';
import { join } from 'path';

const issueSrc = readFileSync(join(__dirname, '..', 'ssoIssueHandler.ts'), 'utf8');
const exchangeSrc = readFileSync(join(__dirname, '..', 'ssoExchangeHandler.ts'), 'utf8');
const callablesSrc = readFileSync(join(__dirname, '..', 'ssoCallables.ts'), 'utf8');

describe('frozen Dashboard SSO handlers', () => {
  it('still exports the original issue/exchange callables', () => {
    expect(callablesSrc).toMatch(/export const ssoIssueAuthorizationCode/);
    expect(callablesSrc).toMatch(/export const ssoExchangeAuthorizationCode/);
    expect(callablesSrc).toMatch(/handleSsoIssueCode/);
    expect(callablesSrc).toMatch(/handleSsoExchange/);
  });

  it('does not require App Check on the existing bridge', () => {
    expect(callablesSrc).toMatch(/enforceAppCheck: false/);
  });

  it('issue still refuses client identity fields', () => {
    expect(issueSrc).toMatch(/CLIENT_FORBIDDEN_IDENTITY_FIELDS/);
    expect(issueSrc).toMatch(/driverHash/);
    expect(issueSrc).toMatch(/passcode/);
  });

  it('exchange still consumes once and uses a generic invalid_grant', () => {
    expect(exchangeSrc).toMatch(/already_consumed/);
    expect(exchangeSrc).toMatch(/GENERIC = 'invalid_grant'/);
    expect(exchangeSrc).toMatch(/pkce_mismatch/);
  });

  it('WBT/equipment audiences from the pinned mirror are unchanged', () => {
    expect(SSO_AUDIENCE_WBT).toBe('wellbuilt-tickets');
    expect(SSO_AUDIENCE_EQUIPMENT).toBe('wellbuilt-equipment');
    expect(isSsoAudience(SSO_AUDIENCE_WBT)).toBe(true);
    expect(isSsoAudience(SSO_AUDIENCE_EQUIPMENT)).toBe(true);
    expect(audienceRequiresShiftBinding(SSO_AUDIENCE_EQUIPMENT)).toBe(true);
    expect(audienceRequiresShiftBinding(SSO_AUDIENCE_WBT)).toBe(false);
    expect(SSO_SESSION_APP_BY_AUDIENCE[SSO_AUDIENCE_WBT]).toBe('wbt');
    expect(SSO_SESSION_APP_BY_AUDIENCE[SSO_AUDIENCE_EQUIPMENT]).toBe('equipment');
  });

  it('does not invent a second issue callable as the Suite path', () => {
    expect(callablesSrc).toMatch(/SSO_ISSUE|ssoIssueAuthorizationCode/);
  });
});
