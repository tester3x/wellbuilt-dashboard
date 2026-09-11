/**
 * Pure invoice upsert decisions. No Admin SDK.
 * Create-if-absent never clobbers; close/upsert may merge.
 */
export type InvoiceUpsertMode = 'create' | 'upsert';

export type InvoiceWriteResult =
  | 'created'
  | 'already_exists'
  | 'updated'
  | 'conflict'
  | 'unauthorized'
  | 'invalid';

const TERMINAL = new Set([
  'closed',
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'void',
]);

export function decideInvoiceWrite(input: {
  invoiceId?: string;
  mode?: InvoiceUpsertMode;
  existing: Record<string, unknown> | null;
  driverId: string;
  companyId?: string;
  nextStatus?: string;
  phoneSplitOperationId?: string;
}): { result: InvoiceWriteResult; write: boolean; merge: boolean } {
  const invoiceId = (input.invoiceId || '').trim();
  if (!invoiceId) return { result: 'invalid', write: false, merge: false };
  if (!input.driverId) return { result: 'unauthorized', write: false, merge: false };

  const mode: InvoiceUpsertMode = input.mode === 'upsert' ? 'upsert' : 'create';
  const existing = input.existing;

  if (!existing) {
    return { result: 'created', write: true, merge: false };
  }

  const prevDriver = typeof existing.driverId === 'string' ? existing.driverId : '';
  const prevHash = typeof existing.driverHash === 'string' ? existing.driverHash : '';
  const owner = prevDriver === input.driverId || prevHash === input.driverId;
  if (prevDriver && !owner) {
    return { result: 'unauthorized', write: false, merge: false };
  }
  const prevCompany = typeof existing.companyId === 'string' ? existing.companyId : '';
  if (input.companyId && prevCompany && prevCompany !== input.companyId) {
    return { result: 'unauthorized', write: false, merge: false };
  }

  if (mode === 'create') {
    const want = (input.phoneSplitOperationId || '').trim();
    const have =
      typeof existing.phoneSplitOperationId === 'string'
        ? existing.phoneSplitOperationId.trim()
        : '';
    if (want && have && want !== have) {
      return { result: 'conflict', write: false, merge: false };
    }
    return { result: 'already_exists', write: false, merge: false };
  }

  const prevStatus = String(existing.status || '').toLowerCase();
  const nextStatus = String(input.nextStatus || prevStatus).toLowerCase();
  if (TERMINAL.has(prevStatus) && !TERMINAL.has(nextStatus)) {
    return { result: 'conflict', write: false, merge: false };
  }
  return { result: 'updated', write: true, merge: true };
}
