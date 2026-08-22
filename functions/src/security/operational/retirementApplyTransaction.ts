/**
 * Conditional approved-row retirement stamp.
 *
 * RTDB update() creates a missing path. A transaction that returns an object
 * from null does the same. This stamp primes a path-specific listener, then
 * aborts (return undefined) unless the live row is the exact Preview
 * fingerprint. Success rereads and requires legacyLoginRetired === true.
 */
import { evaluateApprovedRetirementStamp } from './identityBinding';

export type ApprovedRowRef = {
  on(
    event: 'value',
    callback: (...args: unknown[]) => void,
    cancelCallback?: (err: Error) => void,
  ): unknown;
  off(event: 'value', callback?: (...args: unknown[]) => void): void;
  transaction(
    update: (current: unknown) => unknown,
  ): Promise<{
    committed: boolean;
    snapshot: { exists(): boolean; val(): unknown };
  }>;
  once(event: 'value'): Promise<{ exists(): boolean; val(): unknown }>;
};

export type RetirementStampResult =
  | { ok: true; written: Record<string, unknown> }
  | {
    ok: false;
    reason:
      | 'approved_row_missing'
      | 'approved_row_malformed'
      | 'stale_preview'
      | 'retirement_stamp_aborted'
      | 'legacy_login_not_retired';
  };

export async function commitApprovedRetirementStamp(input: {
  approvedRef: ApprovedRowRef;
  expectedRowFingerprint: string;
}): Promise<RetirementStampResult> {
  let abortReason: Extract<RetirementStampResult, { ok: false }>['reason'] = 'retirement_stamp_aborted';
  let resolvePrime: () => void = () => undefined;
  const listener = () => { resolvePrime(); };
  try {
    await new Promise<void>((resolve, reject) => {
      resolvePrime = resolve;
      input.approvedRef.on('value', listener, (err) => reject(err));
    });
    const tx = await input.approvedRef.transaction((current) => {
      const gate = evaluateApprovedRetirementStamp(current, input.expectedRowFingerprint);
      if (!gate.ok) {
        abortReason = gate.reason;
        return;
      }
      return gate.next;
    });
    if (!tx.committed) {
      return { ok: false, reason: abortReason };
    }
    const reread = await input.approvedRef.once('value');
    const val = reread.val();
    if (
      !val
      || typeof val !== 'object'
      || Array.isArray(val)
      || (val as Record<string, unknown>).legacyLoginRetired !== true
    ) {
      return { ok: false, reason: 'legacy_login_not_retired' };
    }
    return { ok: true, written: val as Record<string, unknown> };
  } finally {
    input.approvedRef.off('value', listener);
  }
}
