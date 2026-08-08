/**
 * vc51.9Y — THE mapper for a failed protected READ.
 *
 * Every rejection from the typed service arrives as an AdminServiceError
 * (kind + adminCode) — never as an object with a `code` property. A caller
 * that inspects `err.code` therefore matches nothing and reports the same
 * useless sentence for a missing claim, a disabled admin record, an ended
 * session and an absent company alike. Normalizing first means a raw
 * firebase/functions rejection maps identically to one the service already
 * converted, so no caller has to know which layer threw.
 *
 * This lives beside adminUiLogic rather than inside it on purpose:
 * adminUiLogic is loaded by tools/test-adminUiLogic.mjs under
 * `node --experimental-strip-types`, which erases types but cannot resolve
 * an extensionless relative RUNTIME import. Keeping the only value import
 * of adminContractServiceCore here leaves that module's imports type-only
 * and the harness able to load it.
 */
import { normalizeAdminError } from './adminContractServiceCore';
import { errorGuidance, type ErrorGuidance } from './adminUiLogic';

export function contractLoadFailure(err: unknown): ErrorGuidance {
  return errorGuidance(normalizeAdminError(err));
}
