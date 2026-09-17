/**
 * Pure, framework-free logic for the Company Join Code admin card.
 *
 * Kept out of the React component so the authorization gate, the callable
 * argument shape (company-isolation), the error copy, and the button label
 * are directly unit-testable (tools/test-companyJoinCode.mjs) without
 * rendering React or mocking Firebase.
 *
 * Backing callable: getCompanyJoinCode (deployed). It is retrieve-or-allocate
 * and NEVER replaces an existing code (no rotation). Server gate =
 * requireManageDrivers.
 */
import { hasCapability, isPlatformAdmin, type WellBuiltUser, type RoleConfig } from './auth';

export type JoinCodeState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; joinCode: string }
  | { phase: 'error'; message: string };

/**
 * Client mirror of the server's requireManageDrivers gate: a platform admin,
 * or a company admin whose role carries the manageDrivers capability. Drivers
 * and other unauthorized users get `false` and must not see the control. The
 * server remains the final authority; this only decides visibility.
 */
export function canManageJoinCode(
  user: WellBuiltUser | null,
  companyConfig?: RoleConfig | null,
): boolean {
  return isPlatformAdmin(user) || hasCapability(user, 'manageDrivers', companyConfig);
}

/**
 * Arguments for getCompanyJoinCode. A company admin sends NO companyId, so the
 * server can only ever resolve their OWN company (caller.companyId) — no other
 * company's code is reachable from this client. Only a platform admin targets a
 * specific company by id.
 */
export function joinCodeCallArgs(
  platformAdmin: boolean,
  companyId: string,
): { companyId?: string } {
  return platformAdmin && companyId ? { companyId } : {};
}

/**
 * Branded, non-leaking error copy from an HttpsError-shaped rejection. Never
 * echoes the raw error or any code/identifier back to the UI.
 */
export function friendlyJoinCodeError(err: unknown): string {
  const code = String((err as { code?: string } | null)?.code || '');
  if (code.includes('unauthenticated') || code.includes('permission-denied')) {
    return 'You are not authorized to view this company’s join code.';
  }
  if (code.includes('invalid-argument')) {
    return 'Select a company before requesting its join code.';
  }
  if (code.includes('unavailable') || code.includes('deadline')) {
    return 'The join-code service is temporarily unavailable. Please try again.';
  }
  return 'Could not load the join code. Please try again.';
}

/**
 * Button label for the fetch control. Only shown while NOT in the `ready`
 * phase (once the code is displayed there is no re-fetch button, so the code is
 * never re-requested or replaced by an idle tap).
 */
export function joinCodeActionLabel(state: JoinCodeState): string {
  switch (state.phase) {
    case 'loading':
      return 'Loading…';
    case 'error':
      return 'Try Again';
    default:
      // "create" is explicit: the first fetch lazily allocates the code.
      return 'Show or create join code';
  }
}
