/**
 * Compare-and-commit canonical profile hydration.
 *
 * Never full-sets a profile from a stale read. The transaction re-reads the
 * live profile, recomputes the bound digest, and aborts as stale_preview
 * when a concurrent assignment/profile write landed.
 */
import {
  applyHydrationCopy,
  hydrationContextDigest,
  profileContainsForbiddenLegacyKey,
  type HydrationPreview,
  type OperationalField,
} from './canonicalProfileHydration';

export type ProfileRef = {
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
};

export type HydrationWriteResult =
  | { ok: true; action: 'written' | 'already_exact'; written: Record<string, unknown> }
  | { ok: false; reason: 'stale_preview' | 'profile_leaks_legacy_key' | 'hydration_aborted' };

export function evaluateHydrationTransaction(input: {
  current: Record<string, unknown> | null;
  driverId: string;
  approvedKey: string;
  expectedDigest: string;
  legacyRow: Record<string, unknown>;
  copy: Partial<Record<OperationalField, unknown>>;
  preview: Pick<HydrationPreview, 'copy' | 'preserved' | 'conflicts'>;
  opId: string;
}): { ok: true; next: Record<string, unknown> } | { ok: false; reason: HydrationWriteResult['ok'] extends false ? never : string } | { ok: false; reason: string } {
  const live = hydrationContextDigest({
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    canonical: input.current,
    legacyRow: input.legacyRow,
    copy: input.copy,
  });
  if (live !== input.expectedDigest) {
    return { ok: false, reason: 'stale_preview' };
  }
  const next = applyHydrationCopy(input.current, {
    copy: input.preview.copy,
    preserved: input.preview.preserved,
    conflicts: input.preview.conflicts,
    digest: input.expectedDigest,
  });
  if (!next.provisioningOpId) next.provisioningOpId = input.opId;
  if (profileContainsForbiddenLegacyKey(next)) {
    return { ok: false, reason: 'profile_leaks_legacy_key' };
  }
  return { ok: true, next };
}

export async function commitCanonicalHydrationWrite(input: {
  profileRef: ProfileRef;
  driverId: string;
  approvedKey: string;
  expectedDigest: string;
  legacyRow: Record<string, unknown>;
  copy: Partial<Record<OperationalField, unknown>>;
  preview: Pick<HydrationPreview, 'copy' | 'preserved' | 'conflicts'>;
  opId: string;
}): Promise<HydrationWriteResult> {
  let abortReason: 'stale_preview' | 'profile_leaks_legacy_key' | 'hydration_aborted' = 'hydration_aborted';
  let written: Record<string, unknown> | null = null;
  let resolvePrime: () => void = () => undefined;
  const listener = () => { resolvePrime(); };
  try {
    await new Promise<void>((resolve, reject) => {
      resolvePrime = resolve;
      input.profileRef.on('value', listener, (err) => reject(err));
    });
    const tx = await input.profileRef.transaction((current) => {
      const rec = current && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown>
        : null;
      const gate = evaluateHydrationTransaction({
        current: rec,
        driverId: input.driverId,
        approvedKey: input.approvedKey,
        expectedDigest: input.expectedDigest,
        legacyRow: input.legacyRow,
        copy: input.copy,
        preview: input.preview,
        opId: input.opId,
      });
      if (!gate.ok) {
        abortReason = (gate.reason === 'stale_preview' || gate.reason === 'profile_leaks_legacy_key')
          ? gate.reason
          : 'hydration_aborted';
        return;
      }
      written = gate.next;
      return gate.next;
    });
    if (!tx.committed || !written) {
      return { ok: false, reason: abortReason };
    }
    return { ok: true, action: 'written', written };
  } finally {
    input.profileRef.off('value', listener);
  }
}
