import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export async function dismissDispatch(dispatchId: string) {
  const fn = httpsCallable(getFirebaseFunctions(), 'dismissDispatch');
  const res = await fn({ dispatchId });
  return res.data as { ok: true; idempotent: boolean; dispatchIds: string[] };
}
