/**
 * Pure, framework-free core for the governed Dashboard pull EDIT.
 *
 * No firebase import lives here so the request-shape and error-mapping logic can
 * be unit-tested with node:test without the client SDK. `pullEdit.ts` composes
 * this with the authenticated `adminSubmitPullEdit` callable.
 */

/** Exact request payload the deployed `adminSubmitPullEdit` callable validates. */
export interface AdminPullEditRequest {
  originalPacketId: string;
  wellName: string;
  tankTopInches: number;
  bblsTaken: number;
  wellDown: boolean;
  /** Optional — only present when the operator changed the pull time. */
  newDateTimeUTC?: string;
}

export interface EditPullResult {
  ok: true;
  packetId: string;
}

/**
 * Injectable callable seam: `(name, data) => Promise<{ data }>`. In production
 * this is a thin adapter over firebase `httpsCallable`; in tests it is a spy, so
 * the invocation boundary (callable name, single call, payload) is verifiable
 * without the firebase SDK or a DOM.
 */
export type CallableInvoker = (name: string, data: AdminPullEditRequest) => Promise<{ data: unknown }>;

/** The one callable this client is allowed to invoke for a pull edit. */
export const ADMIN_PULL_EDIT_CALLABLE = 'adminSubmitPullEdit';

/**
 * Invoke the governed edit callable exactly once with the built request and
 * return its `{ ok, packetId }` data. Never writes to the database directly.
 */
export async function invokeAdminPullEdit(
  call: CallableInvoker,
  req: AdminPullEditRequest,
): Promise<EditPullResult> {
  const res = await call(ADMIN_PULL_EDIT_CALLABLE, req);
  return res.data as EditPullResult;
}

/**
 * Build the callable request. It NEVER mints a packet id and NEVER carries a
 * requestType — the second-pull class of bug is impossible from here: the edit
 * is addressed solely by `originalPacketId`, and the server derives the edit
 * packet id under admin. Deterministic: identical inputs → identical request
 * (so a double-submit/retry targets the same original, not a new pull).
 */
export function buildAdminPullEditRequest(
  originalPacketId: string,
  wellName: string,
  newLevelInches: number,
  newBbls: number,
  newDateTimeUTC?: string,
  wellDown?: boolean,
): AdminPullEditRequest {
  const req: AdminPullEditRequest = {
    originalPacketId,
    wellName,
    tankTopInches: newLevelInches,
    bblsTaken: newBbls,
    wellDown: wellDown === true,
  };
  if (newDateTimeUTC) req.newDateTimeUTC = newDateTimeUTC;
  return req;
}

/** Minimal shape of a firebase/functions FunctionsError we read. */
export interface CallableErrorLike {
  code?: string;
  message?: string;
}

/**
 * Turn a callable error into a short, sanitized, actionable message for the
 * operator. Never surfaces raw exception/transport text. Keys off the server
 * `reason` token (HttpsError message) first, then the transport `code`.
 */
export function describeEditError(err: unknown): string {
  const e = (err ?? {}) as CallableErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const rawMessage = typeof e.message === 'string' ? e.message : '';
  // Server HttpsError messages are single reason tokens (e.g. "tankTopInches_invalid").
  // Some transports prefix the code as "invalid-argument: reason" — take the tail.
  const reason = rawMessage.includes(':')
    ? rawMessage.split(':').pop()!.trim()
    : rawMessage.trim();

  switch (reason) {
    case 'tankTopInches_invalid':
      return 'Enter a valid tank level before saving.';
    case 'bblsTaken_invalid':
      return 'Enter a valid barrels value before saving.';
    case 'newDateTimeUTC_invalid':
      return 'Enter a valid pull date/time before saving.';
    case 'originalPacketId_required':
    case 'originalPacketId_malformed':
    case 'wellName_invalid':
      return 'This pull could not be identified. Refresh the page and try again.';
    case 'well_outside_company':
    case 'manageDrivers_required':
    case 'pool_forbidden':
      return 'You do not have permission to edit this pull.';
    default:
      break;
  }

  if (code === 'unauthenticated') return 'Your session expired. Sign in again and retry.';
  if (code === 'permission-denied') return 'You do not have permission to edit this pull.';
  if (code === 'invalid-argument') return 'This edit was rejected as invalid. Check the values and try again.';
  if (code === 'unavailable' || code === 'internal' || code === 'deadline-exceeded') {
    return 'The edit service is unavailable right now. The pull was NOT changed — try again.';
  }
  return 'Could not save the edit. The pull was NOT changed — try again.';
}
