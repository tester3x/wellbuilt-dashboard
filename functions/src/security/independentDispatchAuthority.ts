import { requireTrustedCompanyCapability } from './trustedStaffAuthority';

/** A tenant owner may operate their installed Independent Dispatch package. */
export async function requireIndependentDispatchAuthority(uid: string | undefined, capability: 'viewDispatch' | 'createDispatch') {
  try { return await requireTrustedCompanyCapability(uid, capability); }
  catch (error) {
    if ((error as { code?: string }).code !== 'permission-denied'
      || !(error as Error).message.startsWith('missing_required_capability:capabilities')) throw error;
    return requireTrustedCompanyCapability(uid, 'manageCompany');
  }
}
