import { createDriverTransferRequest } from '../transferRequestOps';

describe('createDriverTransferRequest callable', () => {
  it('is exported as a callable Gen2 function with run method', () => {
    expect(createDriverTransferRequest).toBeDefined();
    expect(typeof (createDriverTransferRequest as any).run).toBe('function');
  });

  it('validates input parameters (sourceInvoiceDocId and toDriverHash)', async () => {
    await expect(
      (createDriverTransferRequest as any).run({
        data: {},
        auth: { uid: 'u1', token: { kind: 'driver', driverId: 'd1', companyId: 'c1' } } as any,
        rawRequest: {} as any,
      })
    ).rejects.toThrow('sourceInvoiceDocId is required');

    await expect(
      (createDriverTransferRequest as any).run({
        data: { sourceInvoiceDocId: 'inv_1', mode: 'direct' },
        auth: { uid: 'u1', token: { kind: 'driver', driverId: 'd1', companyId: 'c1' } } as any,
        rawRequest: {} as any,
      })
    ).rejects.toThrow('toDriverHash is required for direct mode');
  });
});
