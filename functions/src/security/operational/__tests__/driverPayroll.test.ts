import { parsePayrollWindow, projectOwnPayConfig, projectOwnPayrollInvoice } from '../driverPayroll';

describe('driver payroll boundary', () => {
  const own = { companyId: 'liquid-gold', driverId: 'driver-123', driver: 'Mike',
    createdAt: new Date('2026-10-07T12:00:00.000Z'), status: 'closed', totalBBL: 140 };

  it('accepts a bounded date window and rejects unbounded requests', () => {
    expect(parsePayrollWindow({ startISO: '2026-10-05', endISO: '2026-10-12' })).not.toBeNull();
    expect(parsePayrollWindow({ startISO: '2026-01-01', endISO: '2026-10-12' })).toBeNull();
    expect(parsePayrollWindow({ startISO: '2026-10-12', endISO: '2026-10-05' })).toBeNull();
  });

  it('returns only the authenticated driver and company, including trusted history aliases', () => {
    const keys = ['driver-123', 'bound-legacy-hash'];
    expect(projectOwnPayrollInvoice('mine', own, 'liquid-gold', keys)?.id).toBe('mine');
    expect(projectOwnPayrollInvoice('legacy', { ...own, driverId: undefined, driverHash: 'bound-legacy-hash' }, 'liquid-gold', keys)?.id).toBe('legacy');
    expect(projectOwnPayrollInvoice('other', { ...own, driverId: 'other-driver', driver: 'Mike' }, 'liquid-gold', keys)).toBeNull();
    expect(projectOwnPayrollInvoice('foreign', { ...own, companyId: 'other-company' }, 'liquid-gold', keys)).toBeNull();
    expect(projectOwnPayrollInvoice('name-only', { ...own, driverId: undefined }, 'liquid-gold', keys)).toBeNull();
  });

  it('returns only pay settings needed by Suite', () => {
    const config = projectOwnPayConfig({
      payConfig: { defaultSplit: 0.25, employeeSplit: 0, unrelated: 'private' },
      rateSheets: { Slawson: [{ jobType: 'PW', rate: 2.4 }] },
      billingConfig: { secret: true },
    });
    expect(config).toMatchObject({ employeeSplit: 0, defaultSplit: 0.25 });
    expect(config).not.toHaveProperty('billingConfig');
    expect(JSON.stringify(config)).not.toContain('private');
  });
});
