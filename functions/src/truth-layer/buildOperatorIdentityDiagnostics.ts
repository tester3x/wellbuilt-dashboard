import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type { ValidationWarning } from './validateProjection';
import type { OperatorIdentityDiagnostic } from './types.identityHealth';
import { getIdentityConfidence, getSourceIdentities } from './canonicalIdentity';
import { scoreOperatorIdentitySeverity } from './scoreOperatorIdentitySeverity';

const UNRESOLVED_PREFIX = 'op-unresolved:';
const NAME_ONLY_PREFIX = 'op-name:';

/** Extract human-readable identifier from a canonical/raw operator key. */
function extractLegacyIdentifier(key: string): string | null {
  if (key.startsWith('op:')) return key.slice(3);
  if (key.startsWith('op-uid:')) return key.slice(7);
  if (key.startsWith(NAME_ONLY_PREFIX)) return key.slice(NAME_ONLY_PREFIX.length);
  if (key.startsWith(UNRESOLVED_PREFIX)) return key.slice(UNRESOLVED_PREFIX.length);
  return null;
}

function warningTouchesOperator(
  w: ValidationWarning,
  linkedKeys: Set<string>
): boolean {
  const s = w.subject ?? {};
  for (const candidate of [s.operatorKey, s.strongKey, s.weakKey]) {
    if (typeof candidate === 'string' && linkedKeys.has(candidate)) return true;
  }
  return false;
}

/**
 * Per-canonical-operator diagnostic. Factual only — never infers beyond the
 * observed truth/canonical/warning inputs.
 */
export function buildOperatorIdentityDiagnostics(
  _projection: TruthProjection,
  canonical: CanonicalProjection,
  warnings: ValidationWarning[]
): OperatorIdentityDiagnostic[] {
  const out: OperatorIdentityDiagnostic[] = [];

  for (const op of canonical.canonicalOperators) {
    const linkedKeys = [...op.linkedKeys].sort();
    const linkedSet = new Set(linkedKeys);

    const sourceIdentities = getSourceIdentities(op);
    const identityConfidence = getIdentityConfidence(op);
    const isWeak = identityConfidence === 'weak';
    const isUnresolved = op.canonicalOperatorKey.startsWith(UNRESOLVED_PREFIX);
    const isMergedIdentity = op.mergedFrom.length > 0;
    const hasNameOnlyLinkedKey = linkedKeys.some((k) =>
      k.startsWith(NAME_ONLY_PREFIX)
    );
    const canonicalDiffersFromRaw = linkedKeys.some(
      (k) => k !== op.canonicalOperatorKey
    );

    const opWarnings = warnings.filter((w) =>
      warningTouchesOperator(w, linkedSet)
    );
    const warningKinds = Array.from(
      new Set(opWarnings.map((w) => w.kind))
    ).sort();
    const hasParallelIdentities = warningKinds.includes(
      'operator_parallel_identities'
    );

    const { severity, reasons } = scoreOperatorIdentitySeverity({
      isUnresolved,
      isWeak,
      hasNameOnlyLinkedKey,
      isMerged: isMergedIdentity,
      hasParallelIdentitiesWarning: hasParallelIdentities,
      linkedKeyCount: linkedKeys.length,
      canonicalDiffersFromRaw,
    });

    const legacyIdentifiers = Array.from(
      new Set(
        linkedKeys
          .map((k) => extractLegacyIdentifier(k))
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
      )
    ).sort();

    const diagnostic: OperatorIdentityDiagnostic = {
      canonicalOperatorKey: op.canonicalOperatorKey,
      linkedKeys,
      linkedKeyCount: linkedKeys.length,
      identityConfidence,
      sourceIdentities,
      warningKinds,
      severity,
      reasons,
      rawOperatorKeys: linkedKeys,
      hasParallelIdentities,
      isMergedIdentity,
      isUnresolved,
    };
    if (op.displayName !== undefined) diagnostic.displayName = op.displayName;
    if (legacyIdentifiers.length > 0) diagnostic.legacyIdentifiers = legacyIdentifiers;
    out.push(diagnostic);
  }

  return out.sort((a, b) =>
    a.canonicalOperatorKey.localeCompare(b.canonicalOperatorKey)
  );
}
