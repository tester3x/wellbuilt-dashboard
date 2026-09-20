/**
 * Dormant server-owned policy/effect inventory (G-006).
 * Plain frozen data only. No callables, no I/O, no consumers.
 *
 * G-006A: no contracts capability has a complete server command handler.
 * IMPLEMENTED_EFFECT_IDS is therefore exactly empty.
 * Company/catalog/UI/client gates are not server-owned packet policies,
 * so POLICY_INVENTORY is also empty.
 */

export const INVENTORY_SCHEMA_VERSION = 1 as const;

export const POLICY_RECORD_KEYS = Object.freeze([
  'policyId',
  'policySchemaVersion',
  'enforcementPlane',
  'governs',
  'producesImplementedEffect',
  'safeForPacketPolicyRefs',
  'dependencies',
] as const);

export const CAPABILITY_TRUTH_KEYS = Object.freeze([
  'id',
  'kind',
  'implementedAsServerEffect',
  'producesImplementedEffect',
  'reason',
  'missingSurfaces',
] as const);

export const CAPABILITY_TRUTH_KINDS = Object.freeze([
  'contracts_capability',
  'reserved_capability',
  'client_catalog_alias',
  'client_only_operation',
] as const);

export type CapabilityTruthKind = (typeof CAPABILITY_TRUTH_KINDS)[number];

export type PolicyRecord = {
  readonly policyId: string;
  readonly policySchemaVersion: number;
  readonly enforcementPlane: string;
  readonly governs: string;
  readonly producesImplementedEffect: false;
  readonly safeForPacketPolicyRefs: false;
  readonly dependencies: readonly string[];
};

export type CapabilityTruthRecord = {
  readonly id: string;
  readonly kind: CapabilityTruthKind;
  readonly implementedAsServerEffect: false;
  readonly producesImplementedEffect: false;
  readonly reason: string;
  readonly missingSurfaces: readonly string[];
};

const NONE: false = false;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertPlainData(value: unknown, path: string): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non_finite:${path}`);
    return;
  }
  if (t !== 'object') throw new Error(`unsupported_type:${path}`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`symbol:${path}`);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`non_plain_array:${path}`);
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error(`sparse:${path}[${i}]`);
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || desc.get !== undefined || desc.set !== undefined) {
        throw new Error(`accessor:${path}[${i}]`);
      }
      assertPlainData(desc.value, `${path}[${i}]`);
    }
    return;
  }

  if (!isPlainObject(value as object)) throw new Error(`non_plain_object:${path}`);
  const obj = value as Record<string, unknown>;
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new Error(`inherited:${path}`);
  }
  for (const key of Object.getOwnPropertyNames(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      throw new Error(`accessor:${path}.${key}`);
    }
    if (desc.value === undefined) throw new Error(`undefined:${path}.${key}`);
    assertPlainData(desc.value, `${path}.${key}`);
  }
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) freezeDeep(value[i]);
    return Object.freeze(value);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && desc.value && typeof desc.value === 'object') freezeDeep(desc.value);
  }
  return Object.freeze(value);
}

function exactKeys(obj: object, allowed: readonly string[], path: string): void {
  const keys = Object.getOwnPropertyNames(obj);
  for (const key of keys) {
    if ((allowed as readonly string[]).indexOf(key) < 0) throw new Error(`unknown_key:${path}.${key}`);
  }
  for (const key of allowed) {
    if (keys.indexOf(key) < 0) throw new Error(`missing_key:${path}.${key}`);
  }
}

function uniqueIds(ids: readonly string[], path: string): void {
  const seen = Object.create(null) as Record<string, true>;
  for (const id of ids) {
    if (seen[id]) throw new Error(`duplicate_id:${path}.${id}`);
    seen[id] = true;
  }
}

function truth(
  id: string,
  kind: CapabilityTruthKind,
  reason: string,
  missingSurfaces: readonly string[],
): CapabilityTruthRecord {
  const record: CapabilityTruthRecord = {
    id,
    kind,
    implementedAsServerEffect: NONE,
    producesImplementedEffect: NONE,
    reason,
    missingSurfaces,
  };
  exactKeys(record, CAPABILITY_TRUTH_KEYS, id);
  return record;
}

const capabilityTruthDraft: CapabilityTruthRecord[] = [
  truth('lifecycle', 'contracts_capability', 'no server lifecycle command handler; dispatch writes are not exclusive', ['command_handler', 'exclusive_dispatch_write', 'pinned_revision']),
  truth('onSite', 'contracts_capability', 'UI/geofence only; no onSite.record persistence', ['command_handler', 'persistence']),
  truth('pickup', 'contracts_capability', 'oilfield ticket BBL/level is not pickup.record', ['command_handler', 'stop_protocol', 'hashed_unit_policy']),
  truth('dropoff', 'contracts_capability', 'oilfield disposal fields are not dropoff.record', ['command_handler', 'stop_protocol']),
  truth('multiHaul', 'contracts_capability', 'WB-T V9 client bind only; no multiHaul.join callable', ['command_handler', 'haul_group_revision']),
  truth('splitTicket', 'contracts_capability', 'WB-T V9 client bind only; no splitTicket.addLeg callable', ['command_handler', 'server_chain_validation']),
  truth('transfer', 'contracts_capability', 'transferLoad catalog flag is not contracts transfer; rules remain open', ['command_handler', 'hashed_authority_policy', 'closed_rules']),
  truth('photos', 'contracts_capability', 'company requirePhotos is mutable client config, not photos.attach', ['command_handler', 'hashed_evidence_policy']),
  truth('signatures', 'contracts_capability', 'JSA acknowledge UI is not signatures.attach', ['command_handler', 'hashed_evidence_policy']),
  truth('disposal', 'reserved_capability', 'reserved name; not a grant', ['not_a_grant']),
  truth('multiStop', 'reserved_capability', 'reserved name; not a grant', ['not_a_grant']),
  truth('photoCompliance', 'reserved_capability', 'reserved name; not a grant', ['not_a_grant']),
  truth('jsa', 'reserved_capability', 'reserved name; company JSA config is not a packet grant', ['not_a_grant']),
  truth('dvir', 'reserved_capability', 'reserved name; eQuipment is a separate plane', ['not_a_grant']),
  truth('documents', 'reserved_capability', 'reserved name; not a grant', ['not_a_grant']),
  truth('dispatchAcceptance', 'reserved_capability', 'reserved name; acceptDriverDispatch is not deployed', ['not_a_grant', 'missing_callable']),
  truth('routeNavigation', 'reserved_capability', 'reserved name; not a grant', ['not_a_grant']),
  truth('editing', 'reserved_capability', 'reserved name; not a grant', ['not_a_grant']),
  truth('billing', 'reserved_capability', 'reserved name; billing reads invoices after the fact', ['not_a_grant']),
  truth('payroll', 'reserved_capability', 'reserved name; payroll is not a packet effect', ['not_a_grant']),
  truth('timekeeping', 'reserved_capability', 'reserved name; shift authority is not a PW packet effect', ['not_a_grant']),
  truth('ticketGrouping', 'reserved_capability', 'reserved name; not a grant', ['not_a_grant']),
  truth('wellMonitoring', 'reserved_capability', 'reserved name; WB-M packets are a different domain', ['not_a_grant']),
  truth('splitTickets', 'client_catalog_alias', 'catalog/company alias of splitTicket; client-only', ['server_effect']),
  truth('splitHaul', 'client_catalog_alias', 'catalog alias of multiHaul; client-only', ['server_effect']),
  truth('transferLoad', 'client_catalog_alias', 'catalog boolean; not contracts transfer', ['server_effect']),
  truth('wbMobileSync', 'client_catalog_alias', 'catalog boolean; WB-M well packets are not job-packet effects', ['server_effect']),
  truth('enRoute', 'client_catalog_alias', 'catalog/UI boolean', ['server_effect']),
  truth('routeRecording', 'client_catalog_alias', 'catalog/UI boolean', ['server_effect']),
  truth('addSplitLeg', 'client_only_operation', 'Dashboard dispatch-family split; not splitTicket.addLeg', ['not_an_implemented_effect']),
  truth('acceptDriverDispatch', 'client_only_operation', 'WB-T client contract; callable not on Dashboard Functions', ['not_an_implemented_effect', 'missing_callable']),
  truth('createDriverDispatchIfAbsent', 'client_only_operation', 'WB-T client contract; callable not on Dashboard Functions', ['not_an_implemented_effect', 'missing_callable']),
  truth('upsertDriverDispatch', 'client_only_operation', 'deployed merge-upsert; not a truthful PW command effect', ['not_an_implemented_effect']),
  truth('invoiceCreate', 'client_only_operation', 'S.A.F.E. outbox kind; client replay', ['not_an_implemented_effect']),
  truth('invoiceClose', 'client_only_operation', 'S.A.F.E. outbox kind; client replay', ['not_an_implemented_effect']),
  truth('dispatchAccept', 'client_only_operation', 'S.A.F.E. outbox kind; client replay', ['not_an_implemented_effect']),
  truth('dispatchComplete', 'client_only_operation', 'S.A.F.E. outbox kind; client replay', ['not_an_implemented_effect']),
  truth('dispatchCreate', 'client_only_operation', 'S.A.F.E. outbox kind; client replay', ['not_an_implemented_effect']),
];

uniqueIds(capabilityTruthDraft.map((row) => row.id), 'capabilityTruth');
assertPlainData(capabilityTruthDraft, 'capabilityTruth');

export const CAPABILITY_TRUTH: readonly CapabilityTruthRecord[] = freezeDeep(capabilityTruthDraft);

export const POLICY_INVENTORY: readonly PolicyRecord[] = freezeDeep([] as PolicyRecord[]);

export const IMPLEMENTED_EFFECT_IDS: readonly [] = freezeDeep([] as []);

assertPlainData(INVENTORY_SCHEMA_VERSION, 'schemaVersion');
assertPlainData(POLICY_INVENTORY, 'policies');
assertPlainData(IMPLEMENTED_EFFECT_IDS, 'implementedEffectIds');
uniqueIds(POLICY_INVENTORY.map((row) => row.policyId), 'policies');
uniqueIds(IMPLEMENTED_EFFECT_IDS as readonly string[], 'implementedEffectIds');

export function serializeJobPacketInventory(): string {
  return JSON.stringify({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    policies: POLICY_INVENTORY,
    implementedEffectIds: IMPLEMENTED_EFFECT_IDS,
    capabilityTruth: CAPABILITY_TRUTH,
  });
}
