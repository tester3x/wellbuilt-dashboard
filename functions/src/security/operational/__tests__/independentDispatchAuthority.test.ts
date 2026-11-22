jest.mock('../../trustedStaffAuthority', () => ({ requireTrustedCompanyCapability: jest.fn() }));
import { requireTrustedCompanyCapability } from '../../trustedStaffAuthority';
import { requireIndependentDispatchAuthority } from '../../independentDispatchAuthority';
const trusted = requireTrustedCompanyCapability as jest.Mock;
beforeEach(() => trusted.mockReset());
describe('Independent Dispatch owner access', () => {
  it('uses the named dispatch capability for dispatch staff', async () => {
    trusted.mockResolvedValue({ uid: 'staff', companyId: 'company-a' });
    await expect(requireIndependentDispatchAuthority('staff', 'viewDispatch')).resolves.toMatchObject({ companyId: 'company-a' });
    expect(trusted).toHaveBeenCalledTimes(1);
  });
  it('allows a company owner lacking dispatch capabilities to use the installed package path', async () => {
    trusted.mockRejectedValueOnce(Object.assign(Error('missing_required_capability:capabilities'), { code: 'permission-denied' }))
      .mockResolvedValueOnce({ uid: 'owner', companyId: 'company-a' });
    await expect(requireIndependentDispatchAuthority('owner', 'createDispatch')).resolves.toMatchObject({ companyId: 'company-a' });
    expect(trusted).toHaveBeenNthCalledWith(2, 'owner', 'manageCompany');
  });
  it('never falls back for missing identity or malformed authority', async () => {
    trusted.mockRejectedValueOnce(Object.assign(Error('unauthenticated'), { code: 'unauthenticated' }));
    await expect(requireIndependentDispatchAuthority(undefined, 'viewDispatch')).rejects.toThrow('unauthenticated');
    trusted.mockRejectedValueOnce(Object.assign(Error('trusted_authority_malformed'), { code: 'permission-denied' }));
    await expect(requireIndependentDispatchAuthority('bad', 'viewDispatch')).rejects.toThrow('trusted_authority_malformed');
    expect(trusted).toHaveBeenCalledTimes(2);
  });
});
