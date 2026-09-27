/**
 * Server-owned registered packet policy definitions.
 * Source-only control plane for governed packet capabilities.
 */
import { createHash } from 'crypto';

export type PolicyKind = 'allocation' | 'splitActivation';

export type PolicyDefinition = {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly revision: number;
  readonly kind: PolicyKind;
  readonly industryId: string;
  readonly segmentId: string;
  readonly title: string;
  readonly description: string;
  readonly unit: 'bbl';
  readonly rules: Readonly<Record<string, unknown>>;
};

export const OILFIELD_PRODUCED_WATER_ALLOCATION_V1: PolicyDefinition = Object.freeze({
  schemaVersion: 1,
  policyId: 'oilfield-produced-water-allocation',
  revision: 1,
  kind: 'allocation',
  industryId: 'oil-gas',
  segmentId: 'produced-water',
  title: 'Oilfield Produced Water Multi-Haul Interval Allocation Policy',
  description:
    'Attributes exclusive pickup intervals directly to their respective jobs with paused jobs accruing zero time, and allocates the post-last-pickup shared transit and disposal interval once across grouped loads sharing a disposal destination. Preserves individual ticket identity, rates, and trailer capacity limits.',
  unit: 'bbl',
  rules: Object.freeze({
    allowNegativeQuantities: false,
    apportionmentMethod: 'exclusive_pickup_plus_shared_interval',
    enforceTrailerCapacity: true,
    isolatePausedIntervals: true,
    requireUniformDestination: true,
    sharedIntervalAllocation: 'equal_split',
  }),
});

export const OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH =
  '4599f06f82cbea03b3744c3170e006cd86d36ddf08e7eafd22ec73c002a8147b';

export const OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1: PolicyDefinition = Object.freeze({
  schemaVersion: 1,
  policyId: 'oilfield-produced-water-split-activation',
  revision: 1,
  kind: 'splitActivation',
  industryId: 'oil-gas',
  segmentId: 'produced-water',
  title: 'Oilfield Produced Water Split Ticket Activation Policy',
  description:
    'Governs activation of dispatched and field-created split ticket legs. Enforces sequential activation, non-negative remainder continuation, contiguous lineage, and cumulative volume conservation.',
  unit: 'bbl',
  rules: Object.freeze({
    allowNegativeRemainder: false,
    dispatchedSplitSequentialActivation: true,
    enforceVolumeConservation: true,
    fieldSplitRemainderContinuation: true,
    requireContiguousLineage: true,
    requireDropoffEvidenceBeforeActivation: true,
  }),
});

export const OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1_HASH =
  '64a950746c48a72c537c9b0d0238b76530da3e433d40ba34abc9e06d33d73179';

export type RegisteredCapabilityPolicy = {
  readonly capabilityId: string;
  readonly configKey: string;
  readonly kind: PolicyKind;
  readonly policyId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly definition: PolicyDefinition;
};

export const REGISTERED_CAPABILITY_POLICIES: readonly RegisteredCapabilityPolicy[] = Object.freeze([
  Object.freeze({
    capabilityId: 'multiHaul',
    configKey: 'allocationPolicy',
    kind: 'allocation' as const,
    policyId: OILFIELD_PRODUCED_WATER_ALLOCATION_V1.policyId,
    revision: OILFIELD_PRODUCED_WATER_ALLOCATION_V1.revision,
    contentHash: OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH,
    definition: OILFIELD_PRODUCED_WATER_ALLOCATION_V1,
  }),
  Object.freeze({
    capabilityId: 'splitTicket',
    configKey: 'activationPolicy',
    kind: 'splitActivation' as const,
    policyId: OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1.policyId,
    revision: OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1.revision,
    contentHash: OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1_HASH,
    definition: OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1,
  }),
]);

export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonString).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonString((value as Record<string, unknown>)[k])).join(',') + '}';
}

export function computePolicyContentHash(definition: PolicyDefinition): string {
  return createHash('sha256').update(canonicalJsonString(definition), 'utf8').digest('hex');
}

export function findRegisteredPolicy(
  capabilityId: string,
  configKey: string,
  ref: unknown,
): RegisteredCapabilityPolicy | null {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const r = ref as { policyId?: unknown; revision?: unknown; contentHash?: unknown };
  for (const entry of REGISTERED_CAPABILITY_POLICIES) {
    if (
      entry.capabilityId === capabilityId &&
      entry.configKey === configKey &&
      r.policyId === entry.policyId &&
      r.revision === entry.revision &&
      r.contentHash === entry.contentHash
    ) {
      return entry;
    }
  }
  return null;
}
