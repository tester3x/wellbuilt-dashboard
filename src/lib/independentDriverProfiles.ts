import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export type OperatorReviewNote = {
  customerId: string;
  dispatchNote: string;
  operatorFeedback: string;
  reviewPending: boolean;
};

export type IndependentDriverProfileInput = {
  driverKey: string;
  primaryCustomerId: string;
  standingWork: string;
  sideJobs: 'ask' | 'yes' | 'no';
  shiftPreference?: 'day' | 'night' | 'either' | 'unset';
  operatorNotes: OperatorReviewNote[];
};

export type IndependentDriverProfile = IndependentDriverProfileInput & {
  companyId: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
};

function invoke(payload: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, { ok: true; companyId?: string; profiles?: IndependentDriverProfile[]; profile?: IndependentDriverProfile }>(
    getFirebaseFunctions(), 'staffIndependentDriverProfiles')(payload);
}

export async function listIndependentDriverProfiles(): Promise<IndependentDriverProfile[]> {
  return (await invoke({ op: 'list' })).data.profiles || [];
}

export async function saveIndependentDriverProfile(profile: IndependentDriverProfileInput, expectedRevision: number): Promise<IndependentDriverProfile> {
  const result = (await invoke({ op: 'save', profile, expectedRevision })).data.profile;
  if (!result) throw Error('Profile save returned no result.');
  return result;
}
