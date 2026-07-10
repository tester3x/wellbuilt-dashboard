/**
 * WB eQuipment — Assignment custody client (eQuipmentAssignments callable).
 */

import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '../firebase';
import type { Assignment } from './assignmentTypes';

type AssignmentAction =
  | 'assignment.listForCompany'
  | 'assignment.getActiveForEquipment';

async function callAssignments<T = Record<string, unknown>>(
  action: AssignmentAction,
  payload: Record<string, unknown>,
): Promise<T> {
  const fn = httpsCallable(getFirebaseFunctions(), 'eQuipmentAssignments');
  const result = await fn({ action, payload });
  return result.data as T;
}

export async function listAssignmentsForCompany(companyId: string): Promise<Assignment[]> {
  const res = await callAssignments<{ assignments?: Assignment[] }>(
    'assignment.listForCompany',
    { companyId },
  );
  return res.assignments || [];
}