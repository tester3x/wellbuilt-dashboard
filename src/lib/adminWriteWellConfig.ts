import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export async function adminWriteWellConfig(input: {
  op: 'add' | 'update' | 'rename' | 'setRoute' | 'deleteConfig';
  wellName: string;
  newName?: string;
  record?: Record<string, unknown>;
}): Promise<{ wellName: string; newName?: string }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminWriteWellConfig');
  const res = await fn(input);
  return res.data as { wellName: string; newName?: string };
}
