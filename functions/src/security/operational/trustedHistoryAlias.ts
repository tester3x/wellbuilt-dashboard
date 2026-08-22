/**
 * Trusted history alias resolution.
 *
 * Authenticated canonical UUID is the active identity. Historical records
 * stay in place, keyed by UUID and/or the server-controlled bound approved
 * key. Clients may not supply an arbitrary legacy key when requesting
 * history — any client-supplied alias is alias_spoof.
 */
import {
  parseBinding,
  type IdentityBinding,
} from './identityBinding';

const FORBIDDEN_CLIENT_ALIAS_KEYS = [
  'approvedKey',
  'legacyHash',
  'legacyKey',
  'historyKeys',
  'historyAliases',
  'trustedHistoryDriverIds',
  'alias',
  'aliases',
] as const;

export function clientSuppliedAliasKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  return FORBIDDEN_CLIENT_ALIAS_KEYS.filter((k) => o[k] !== undefined);
}

export type HistoryKeyDecision =
  | { action: 'ok'; keys: string[] }
  | { action: 'refuse'; reason: 'alias_spoof' };

/**
 * Resolve the trusted driver-id set for history reads. Always includes the
 * authenticated canonical UUID. Includes the bound approved key when a
 * server-controlled binding exists (active or retired — retirement does not
 * hide history). Client-supplied keys are refused, never unioned.
 */
export function decideTrustedHistoryKeys(input: {
  authenticatedDriverId: string;
  binding: IdentityBinding | null;
  requestData?: unknown;
}): HistoryKeyDecision {
  if (clientSuppliedAliasKeys(input.requestData).length > 0) {
    return { action: 'refuse', reason: 'alias_spoof' };
  }
  const keys = [input.authenticatedDriverId];
  if (
    input.binding
    && input.binding.driverId === input.authenticatedDriverId
    && input.binding.approvedKey
    && !keys.includes(input.binding.approvedKey)
  ) {
    keys.push(input.binding.approvedKey);
  }
  return { action: 'ok', keys };
}

export function recordMatchesTrustedHistory(
  recordDriverId: unknown,
  trustedKeys: string[],
): boolean {
  if (typeof recordDriverId !== 'string' || !recordDriverId) return false;
  return trustedKeys.includes(recordDriverId);
}

export function bindingFromRaw(raw: unknown): IdentityBinding | null {
  return parseBinding(raw);
}
