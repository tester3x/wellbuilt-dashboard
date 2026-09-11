import { decideInvoiceWrite } from '../invoiceUpsertCore';

const DRIVER = 'drv-1';
const COMPANY = 'liquid-gold';

describe('decideInvoiceWrite', () => {
  it('requires a stable invoiceId and never mints idem_ ids', () => {
    expect(decideInvoiceWrite({
      invoiceId: '',
      existing: null,
      driverId: DRIVER,
    }).result).toBe('invalid');
  });

  it('creates when absent at the supplied id', () => {
    const d = decideInvoiceWrite({
      invoiceId: 'docN',
      mode: 'create',
      existing: null,
      driverId: DRIVER,
      companyId: COMPANY,
    });
    expect(d).toEqual({ result: 'created', write: true, merge: false });
  });

  it('second create at the same id is already_exists without a write', () => {
    const d = decideInvoiceWrite({
      invoiceId: 'docN',
      mode: 'create',
      existing: { driverId: DRIVER, companyId: COMPANY, status: 'open' },
      driverId: DRIVER,
      companyId: COMPANY,
    });
    expect(d).toEqual({ result: 'already_exists', write: false, merge: false });
  });

  it('phone-split operation mismatch is conflict, not overwrite', () => {
    const d = decideInvoiceWrite({
      invoiceId: 'child',
      mode: 'create',
      existing: { driverId: DRIVER, phoneSplitOperationId: 'op-a' },
      driverId: DRIVER,
      phoneSplitOperationId: 'op-b',
    });
    expect(d.result).toBe('conflict');
    expect(d.write).toBe(false);
  });

  it('rejects another driver and cross-company', () => {
    expect(decideInvoiceWrite({
      invoiceId: 'docN',
      existing: { driverId: 'other' },
      driverId: DRIVER,
    }).result).toBe('unauthorized');
    expect(decideInvoiceWrite({
      invoiceId: 'docN',
      existing: { driverId: DRIVER, companyId: 'other-co' },
      driverId: DRIVER,
      companyId: COMPANY,
    }).result).toBe('unauthorized');
  });

  it('upsert close may merge; reopen of terminal is conflict', () => {
    const close = decideInvoiceWrite({
      invoiceId: 'docN',
      mode: 'upsert',
      existing: { driverId: DRIVER, status: 'open' },
      driverId: DRIVER,
      nextStatus: 'closed',
    });
    expect(close).toEqual({ result: 'updated', write: true, merge: true });
    const reopen = decideInvoiceWrite({
      invoiceId: 'docN',
      mode: 'upsert',
      existing: { driverId: DRIVER, status: 'closed' },
      driverId: DRIVER,
      nextStatus: 'open',
    });
    expect(reopen.result).toBe('conflict');
    expect(reopen.write).toBe(false);
  });
});
