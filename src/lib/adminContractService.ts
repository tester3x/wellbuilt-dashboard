/**
 * Production binding for the vc51.9A6-B typed admin service.
 *
 * All types, error normalization, and method wiring live in
 * adminContractServiceCore.ts (dependency-free, matrix-tested by
 * tools/test-adminService.mjs). This wrapper only supplies the real
 * transport: firebase/functions httpsCallable over the shared app.
 *
 * CALLABLE-ONLY: neither file imports 'firebase/firestore' — there is
 * no direct protected-write fallback, pinned by the service test.
 */

import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import {
  createAdminContractServiceCore,
  type AdminContractService,
  type CallFn,
} from './adminContractServiceCore';

export * from './adminContractServiceCore';

function productionCall(): CallFn {
  return async (name, data) => {
    const fn = httpsCallable(getFirebaseFunctions(), name);
    const result = await fn(data);
    return result.data;
  };
}

/** Emulator/test injection: pass a CallFn; production omits it. */
export function createAdminContractService(call?: CallFn): AdminContractService {
  return createAdminContractServiceCore(call ?? productionCall());
}
