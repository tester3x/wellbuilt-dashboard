import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export async function staffCreateProject(record: Record<string, unknown>): Promise<{ projectId: string }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteProject');
  const res = await fn({ op: 'create', record });
  return res.data as { projectId: string };
}

export async function staffUpdateProject(projectId: string, record: Record<string, unknown>): Promise<void> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteProject');
  await fn({ op: 'update', projectId, record });
}
