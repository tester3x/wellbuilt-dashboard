import { readFileSync } from 'fs';
import { join } from 'path';
import {
  executeDriverOwnedWrite,
  requireVerifiedDriverIdentity,
  rejectSpoofedResourceIdentity,
} from '../driverOwnedWrite';

const ingestSrc = readFileSync(join(__dirname, '..', 'packetIngest.ts'), 'utf8');
const invoiceSrc = readFileSync(join(__dirname, '..', 'invoiceOps.ts'), 'utf8');

const driver = {
  uid: 'uid-1',
  driverId: 'drv-1',
  companyId: 'liquid-gold',
  authSource: 'claims',
};

describe('ingestDriverPacket / upsertDriverInvoice auth precedes payload', () => {
  test('ingestDriverPacket calls requireSecureDriver before packet required', () => {
    const authIdx = ingestSrc.indexOf('requireSecureDriver(request');
    const payloadIdx = ingestSrc.indexOf("'packet required'");
    expect(authIdx).toBeGreaterThan(-1);
    expect(payloadIdx).toBeGreaterThan(authIdx);
  });

  test('upsertDriverInvoice calls requireSecureDriver before invoice required', () => {
    const start = invoiceSrc.indexOf('export const upsertDriverInvoice');
    const block = invoiceSrc.slice(start, invoiceSrc.indexOf('export const upsertDriverDispatch'));
    const authIdx = block.indexOf('requireSecureDriver(request');
    const payloadIdx = block.indexOf("'invoice required'");
    expect(authIdx).toBeGreaterThan(-1);
    expect(payloadIdx).toBeGreaterThan(authIdx);
  });

  test('unauthenticated empty packet writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: null,
      payload: undefined,
      payloadKey: 'packet',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'unauthenticated' });
    expect(store.writes).toHaveLength(0);
  });

  test('unauthenticated full packet writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: null,
      payload: { wellName: 'GABRIEL 1', bblsTaken: 80, companyId: 'liquid-gold', driverId: 'drv-1' },
      payloadKey: 'packet',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'unauthenticated' });
    expect(store.writes).toHaveLength(0);
  });

  test('authenticated empty packet is 400 after auth and writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: driver,
      payload: undefined,
      payloadKey: 'packet',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'packet_required' });
    expect(store.writes).toHaveLength(0);
  });

  test('wrong-company packet writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: driver,
      payload: { wellName: 'GABRIEL 1', companyId: 'other-co' },
      payloadKey: 'packet',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'cross_company' });
    expect(store.writes).toHaveLength(0);
  });

  test('wrong-driver packet writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: driver,
      payload: { wellName: 'GABRIEL 1', driverId: 'other-driver' },
      payloadKey: 'packet',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'wrong_driver' });
    expect(store.writes).toHaveLength(0);
  });

  test('malformed identity writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: { uid: 'uid-1', driverId: 'drv-1' },
      payload: { wellName: 'GABRIEL 1' },
      payloadKey: 'packet',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'malformed_identity' });
    expect(store.writes).toHaveLength(0);
  });

  test('unauthenticated empty invoice writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: null,
      payload: undefined,
      payloadKey: 'invoice',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'unauthenticated' });
    expect(store.writes).toHaveLength(0);
  });

  test('wrong-company invoice writes nothing', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: driver,
      payload: { status: 'open', companyId: 'other-co' },
      payloadKey: 'invoice',
      store,
    });
    expect(res).toEqual({ ok: false, error: 'cross_company' });
    expect(store.writes).toHaveLength(0);
  });

  test('authorized matching packet writes once with claimed identity', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const res = executeDriverOwnedWrite({
      driverRaw: driver,
      payload: { wellName: 'GABRIEL 1', isAdmin: true },
      payloadKey: 'packet',
      store,
    });
    expect(res).toEqual({ ok: true });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].companyId).toBe('liquid-gold');
    expect(store.writes[0].driverId).toBe('drv-1');
    expect(store.writes[0].isAdmin).toBeUndefined();
  });

  test('duplicate idempotency key does not write a second packet', () => {
    const store = { writes: [] as Record<string, unknown>[] };
    const payload = { wellName: 'GABRIEL 1', idempotencyKey: 'abc12345' };
    expect(executeDriverOwnedWrite({ driverRaw: driver, payload, payloadKey: 'packet', store }).ok).toBe(true);
    const second = executeDriverOwnedWrite({ driverRaw: driver, payload, payloadKey: 'packet', store });
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(store.writes).toHaveLength(1);
  });

  test('verified identity helper rejects missing company', () => {
    expect(requireVerifiedDriverIdentity({ uid: 'u', driverId: 'd' }).ok).toBe(false);
  });

  test('spoof helper rejects cross-company before stamp', () => {
    const verified = requireVerifiedDriverIdentity(driver);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const spoof = rejectSpoofedResourceIdentity(verified.driver, { companyId: 'x' });
    expect(spoof.ok).toBe(false);
    if (!spoof.ok) expect(spoof.error).toBe('cross_company');
  });
});
