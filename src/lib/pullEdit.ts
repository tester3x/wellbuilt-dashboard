/**
 * Governed Dashboard pull EDIT client.
 *
 * Replaces the legacy direct RTDB write to packets/incoming (which the deployed
 * secure rules refuse — `packets/incoming` is {".read":false,".write":false} —
 * the cause of the silent "dashboard edit failed": the write was PERMISSION_DENIED,
 * so no packet ever landed, processEditRequest never fired, and no callable log,
 * receipt, or edit-history was produced). Edit now goes through the authenticated
 * `adminSubmitPullEdit` callable, which validates, enforces manageDrivers +
 * company scope, and writes the edit packet under admin. There is deliberately
 * NO direct database fallback here.
 *
 * The edit is addressed only by the immutable `originalPacketId`; no new pull
 * packet is ever minted client-side.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import {
  buildAdminPullEditRequest,
  invokeAdminPullEdit,
  type AdminPullEditRequest,
  type EditPullResult,
} from './pullEditCore';

export { describeEditError } from './pullEditCore';
export type { EditPullResult } from './pullEditCore';

/** Production adapter: run one governed callable by name and return its result. */
const httpsCallableInvoker = (name: string, data: AdminPullEditRequest) =>
  httpsCallable(getFirebaseFunctions(), name)(data);

/**
 * Governed edit of a pull by its immutable originalPacketId + its (scope) well.
 * Resolves to `{ ok, packetId }` (the server-minted edit packet id) on success;
 * rejects with a FunctionsError on failure (map it with `describeEditError`).
 */
export async function editPull(
  originalPacketId: string,
  wellName: string,
  newLevelInches: number,
  newBbls: number,
  newDateTimeUTC?: string,
  wellDown?: boolean,
): Promise<EditPullResult> {
  const req = buildAdminPullEditRequest(
    originalPacketId,
    wellName,
    newLevelInches,
    newBbls,
    newDateTimeUTC,
    wellDown,
  );
  return invokeAdminPullEdit(httpsCallableInvoker, req);
}
