import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export type PendingCompanyRequest = {
  uid: string;
  email?: string | null;
  requestedCompanyName?: string | null;
  requestedAt?: number | null;
};

export async function requestCompanyOnboarding(companyName: string): Promise<void> {
  const fn = httpsCallable(getFirebaseFunctions(), 'requestCompanyOnboarding');
  await fn({ companyName });
}

export async function listCompanyOnboardingRequests(): Promise<PendingCompanyRequest[]> {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminListCompanyOnboardingRequests');
  const result = await fn({});
  return ((result.data as { requests?: PendingCompanyRequest[] })?.requests || []);
}

export async function approveCompanyOnboarding(uid: string, companyName?: string) {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminApproveCompanyOnboarding');
  const result = await fn({ uid, ...(companyName ? { companyName } : {}) });
  return result.data as { ok: true; companyId: string; companyName: string; joinCode: string | null; alreadyApproved?: boolean };
}

export async function createCompanyWithJoinCode(input: {
  companyId?: string;
  companyName: string;
  fields?: Record<string, unknown>;
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminCreateCompanyWithJoinCode');
  const result = await fn(input);
  return result.data as { ok: true; companyId: string; companyName: string; joinCode: string };
}

export async function fetchCompanyJoinCode(companyId: string) {
  const fn = httpsCallable(getFirebaseFunctions(), 'getCompanyJoinCode');
  const result = await fn({ companyId });
  return result.data as { companyId: string; joinCode: string };
}
