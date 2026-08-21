import {
  decideFieldCommandShape,
  decideWellAssignment,
  decideWellDownAuthority,
  decideOwnership,
  decideResourceCompany,
  stripClientIdentity,
  FIELD_COMMAND_MAX_BYTES,
} from '../fieldCommands';
import {
  applyFieldCommandMutation,
  applyIncomingVersionState,
  FieldApplyInterrupt,
  incrementIncomingVersionValue,
  outgoingResponseId,
  type FieldApplyStores,
  type FieldEffectName,
} from '../fieldCommandApply';
import { nextRateWindow } from '../../rateLimitTxn';
import {
  canonicalReceiptKey,
  contentDigest,
  decideLease,
  decideVersionAck,
  nextLeaseApplyPlan,
} from '../fieldCommandLease';
import type { SecureDriver } from '../../requireDriverAuth';

const pull = {
  requestType: 'pull',
  packetId: '20260816_120000_WellA_abc123',
  wellName: 'Gab 1',
  dateTimeUTC: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  dateTime: '8/16/2026 12:00 PM',
  timezone: 'America/Chicago',
  tankLevelFeet: 12,
  bblsTaken: 80,
};

const driver: SecureDriver = {
  uid: 'driver_aaa',
  driverId: 'drv-a',
  companyId: 'liquid-gold',
  roles: ['driver'],
  displayName: 'MikeS24',
  authSource: 'claims',
};

function memStores(over: Partial<{
  processed: Record<string, Record<string, unknown>>;
  receipts: Record<string, any>;
  version: string;
  wellDown: boolean;
  wellConfig: Record<string, unknown>;
}> = {}) {
  const processed = { ...(over.processed || {}) };
  const outgoing: Record<string, Record<string, unknown>> = {};
  const versions: string[] = [over.version || '0'];
  const rec = {
    processed,
    outgoing,
    versions,
    createAttempts: [] as string[],
    deletedTargets: [] as string[],
  };
  const invoices: Record<string, Record<string, unknown>> = {};
  const dispatches: Record<string, Record<string, unknown>> = {};
  const stores: FieldApplyStores = {
    getProcessed: async (id) => processed[id] || null,
    createProcessedOnly: async (id, data) => {
      rec.createAttempts.push(id);
      if (processed[id]) {
        const err = new Error('packet_collision') as Error & { code: string };
        err.code = 'packet_collision';
        throw err;
      }
      processed[id] = data;
    },
    updateProcessed: async (id, patch) => {
      processed[id] = { ...(processed[id] || {}), ...patch };
      if (patch.deleted === true) rec.deletedTargets.push(id);
    },
    listProcessedForWell: async (wellName, companyId) =>
      Object.entries(processed)
        .filter(([, d]) => d.wellName === wellName && d.companyId === companyId)
        .map(([id, data]) => ({ id, data })),
    replaceOutgoingForWell: async (wellName, companyId, responseId, response) => {
      for (const [k, v] of Object.entries(outgoing)) {
        if (v.wellName === wellName && v.companyId === companyId) delete outgoing[k];
      }
      outgoing[responseId] = { ...response, wellName, companyId };
    },
    incrementIncomingVersion: async () => {
      versions.push(incrementIncomingVersionValue(versions[versions.length - 1]));
    },
    setWellDown: async () => undefined,
    getWellDown: async () => over.wellDown === true,
    getWellConfig: async () =>
      over.wellConfig || { companyId: 'liquid-gold', tanks: 1, route: 'lg-north', bblPerFoot: 24 },
    updateLinkedInvoice: async (id, patch) => {
      invoices[id] = { ...(invoices[id] || {}), ...patch };
    },
    updateLinkedDispatch: async (id, patch) => {
      dispatches[id] = { ...(dispatches[id] || {}), ...patch };
    },
    getLinkedInvoice: async (id) => invoices[id] || null,
    getLinkedDispatch: async (id) => dispatches[id] || null,
    getLinkedTicket: async () => null,
    updateLinkedTicket: async () => undefined,
    persistEffect: async () => undefined,
    incrementIncomingVersionOnce: async () => {
      versions.push(incrementIncomingVersionValue(versions[versions.length - 1]));
    },
    patchOutgoing: async (id, patch) => {
      outgoing[id] = { ...(outgoing[id] || {}), ...patch };
    },
    getOutgoing: async (id) => outgoing[id] || null,
    transactProcessed: async (id, apply) => {
      const next = apply(processed[id] || null);
      if (next === undefined) return { committed: false, snapshot: processed[id] || null };
      processed[id] = next;
      return { committed: true, snapshot: next };
    },
    transactOutgoing: async (id, apply) => {
      const next = apply(outgoing[id] || null);
      if (next === undefined) return { committed: false, snapshot: outgoing[id] || null };
      outgoing[id] = next;
      return { committed: true, snapshot: next };
    },
  };
  return Object.assign(stores, rec, { invoices, dispatches });
}

describe('field command schema', () => {
  it('accepts a minimal WB-M pull after stripping identity', () => {
    const d = decideFieldCommandShape({
      ...pull,
      driverId: 'client-forged',
      driverName: 'Forged',
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.type).toBe('pull');
  });

  it('rejects client wellDownIsAuthoritative', () => {
    expect(
      decideFieldCommandShape({ ...pull, wellDownIsAuthoritative: true }),
    ).toMatchObject({ ok: false, reason: 'unknown_field' });
  });

  it('rejects RTDB-special well name characters and out-of-bound timestamps', () => {
    expect(decideFieldCommandShape({ ...pull, wellName: 'Gab/1' }).ok).toBe(false);
    expect(decideFieldCommandShape({ ...pull, wellName: 'Gab#1' }).ok).toBe(false);
    expect(
      decideFieldCommandShape({ ...pull, dateTimeUTC: '1999-01-01T00:00:00.000Z' }).ok,
    ).toBe(false);
  });

  it('accepts a WB-T pull after stripping company/origin identity and schemaing ops context', () => {
    const d = decideFieldCommandShape({
      ...pull,
      driverName: 'WB-T driver',
      driverId: 'legacy-hash',
      companyId: 'forged-company',
      jobType: 'water-hauling',
      jobOrigin: 'invoice',
      invoicingMode: 'invoice_tickets',
      originAppContext: 'wbt',
      invoiceDocId: 'INV_123456',
      dispatchId: 'DSP_123456',
    });
    expect(d.ok).toBe(true);
  });

  it('rejects unknown fields that are not identity or operational context', () => {
    const d = decideFieldCommandShape({ ...pull, isAdmin: true, godMode: true });
    expect(d).toMatchObject({ ok: false, reason: 'unknown_field' });
    expect(String((d as any).detail)).toContain('godMode');
  });

  it('strips identity so forged driverId never reaches the allowlist', () => {
    const stripped = stripClientIdentity({ ...pull, driverId: 'x', companyId: 'y', roles: ['admin'] });
    expect(stripped).not.toHaveProperty('driverId');
    expect(stripped).not.toHaveProperty('companyId');
    expect(stripped).not.toHaveProperty('roles');
    expect(stripped.packetId).toBe(pull.packetId);
  });

  it('rejects oversized payloads', () => {
    const d = decideFieldCommandShape({
      ...pull,
      dateTime: 'x'.repeat(FIELD_COMMAND_MAX_BYTES),
    });
    expect(d).toMatchObject({ ok: false, reason: 'oversized' });
  });

  it('rejects malformed packet ids and timestamps', () => {
    expect(decideFieldCommandShape({ ...pull, packetId: 'bad id' }).ok).toBe(false);
    expect(decideFieldCommandShape({ ...pull, dateTimeUTC: 'tomorrow' }).ok).toBe(false);
    expect(decideFieldCommandShape({ ...pull, tankLevelFeet: -1 }).ok).toBe(false);
    expect(decideFieldCommandShape({ ...pull, bblsTaken: 99999 }).ok).toBe(false);
  });

  it('requires originalPacketId for edit/delete', () => {
    expect(
      decideFieldCommandShape({
        requestType: 'edit',
        packetId: pull.packetId,
        wellName: 'Gab 1',
        dateTimeUTC: pull.dateTimeUTC,
        tankLevelFeet: 10,
        bblsTaken: 10,
      }).ok,
    ).toBe(false);
  });
});

describe('field command authorization', () => {
  it('denies cross-company wells', () => {
    const d = decideWellAssignment({
      driverCompanyId: 'liquid-gold',
      wellCompanyId: 'acme-eog-test',
      wellName: 'Gab 1',
    });
    expect(d).toMatchObject({ ok: false, reason: 'cross_company' });
  });

  it('denies unscoped wells fail-closed', () => {
    expect(
      decideWellAssignment({
        driverCompanyId: 'liquid-gold',
        wellCompanyId: null,
        wellName: 'Gab 1',
      }),
    ).toMatchObject({ ok: false, reason: 'well_unscoped' });
    expect(
      decideWellAssignment({
        driverCompanyId: 'liquid-gold',
        wellCompanyId: undefined,
        wellName: 'Gab 1',
      }),
    ).toMatchObject({ ok: false, reason: 'well_unscoped' });
  });

  it('denies wells not on the assigned route list', () => {
    const d = decideWellAssignment({
      driverCompanyId: 'liquid-gold',
      wellCompanyId: 'liquid-gold',
      assignedRoutes: ['lg-south'],
      wellName: 'Gab 1',
      wellRoute: 'lg-north',
    });
    expect(d).toMatchObject({ ok: false, reason: 'well_not_assigned' });
  });

  it('does not treat assignedRoutes as well names — resolves well_config.route', () => {
    expect(
      decideWellAssignment({
        driverCompanyId: 'liquid-gold',
        wellCompanyId: 'liquid-gold',
        assignedRoutes: ['Gab 1'],
        wellName: 'Gab 1',
        wellRoute: 'lg-north',
      }),
    ).toMatchObject({ ok: false, reason: 'well_not_assigned' });
    expect(
      decideWellAssignment({
        driverCompanyId: 'liquid-gold',
        wellCompanyId: 'liquid-gold',
        assignedRoutes: ['lg-north'],
        wellName: 'Gab 1',
        wellRoute: 'lg-north',
      }).ok,
    ).toBe(true);
  });

  it('refuses missing canonical assignment instead of granting all company wells', () => {
    expect(
      decideWellAssignment({
        driverCompanyId: 'liquid-gold',
        wellCompanyId: 'liquid-gold',
        wellName: 'Gab 1',
        wellRoute: 'lg-north',
      }),
    ).toMatchObject({ ok: false, reason: 'assignment_unavailable' });
  });

  it('authorizes Class-2 metadata shapes via assignedWells or well route', () => {
    const class2 = [
      { name: 'iPhone16', assignedRoutes: ['lg-north', 'lg-mid', 'lg-south'], assignedWells: undefined },
      { name: 'TabletS10', assignedRoutes: ['lg-north'], assignedWells: ['Gab 1'] },
      { name: 'AdanS', assignedRoutes: undefined, assignedWells: ['Gab 1'] },
      { name: 'Marcial Lebaron', assignedRoutes: ['lg-north'], assignedWells: undefined },
      { name: 'Wisho-135', assignedRoutes: undefined, assignedWells: ['Gab 1'] },
    ];
    for (const d of class2) {
      expect(
        decideWellAssignment({
          driverCompanyId: 'liquid-gold',
          wellCompanyId: 'liquid-gold',
          assignedRoutes: d.assignedRoutes,
          assignedWells: d.assignedWells,
          wellName: 'Gab 1',
          wellRoute: 'lg-north',
        }).ok,
      ).toBe(true);
    }
  });

  it('lets a driver report well-down but not clear an existing down', () => {
    expect(
      decideWellDownAuthority({
        wantsWellDown: true,
        isManager: false,
      }).ok,
    ).toBe(true);
    expect(
      decideWellDownAuthority({
        wantsWellDown: false,
        isManager: false,
        existingDown: true,
      }),
    ).toMatchObject({ ok: false, reason: 'well_down_forbidden' });
    expect(
      decideWellDownAuthority({
        wantsWellDown: false,
        isManager: true,
        existingDown: true,
      }).ok,
    ).toBe(true);
  });

  it('denies non-owner edit/delete', () => {
    expect(
      decideOwnership({
        type: 'edit',
        isManager: false,
        callerDriverId: 'a',
        originalDriverId: 'b',
      }),
    ).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(
      decideOwnership({
        type: 'delete',
        isManager: true,
        callerDriverId: 'a',
        originalDriverId: 'b',
      }).ok,
    ).toBe(true);
  });

  it('denies arbitrary invoice/dispatch company mismatch and missing company', () => {
    expect(
      decideResourceCompany({
        resourceCompanyId: 'acme-eog-test',
        driverCompanyId: 'liquid-gold',
      }),
    ).toMatchObject({ ok: false, reason: 'resource_mismatch' });
    expect(
      decideResourceCompany({
        resourceCompanyId: null,
        driverCompanyId: 'liquid-gold',
      }),
    ).toMatchObject({ ok: false, reason: 'resource_mismatch' });
  });
});

describe('pull create-only and outgoing contract', () => {
  it('writes processed create-only and a waiter-compatible outgoing id', async () => {
    const s = memStores();
    const r = await applyFieldCommandMutation(s, {
      type: 'pull',
      packetId: pull.packetId,
      stamped: { ...pull, companyId: 'liquid-gold', wellDownIsAuthoritative: true, wellDown: false },
      driver,
      manager: false,
    });
    expect(r.targetPacketId).toBe(pull.packetId);
    expect(r.outgoingId).toBe(outgoingResponseId(pull.packetId, 'Gab 1', 'liquid-gold'));
    expect(r.outgoingId).toBe('response_liquid-gold_20260816_120000_Gab1');
    expect(s.processed[pull.packetId].driverId).toBe('drv-a');
    expect(s.processed[pull.packetId].companyId).toBe('liquid-gold');
    expect(s.outgoing[r.outgoingId!].companyId).toBe('liquid-gold');
    expect(s.outgoing[r.outgoingId!].wellName).toBe('Gab 1');
    expect(s.versions[s.versions.length - 1]).toBe('1');
  });

  it('denies pull overwrite of an existing packet', async () => {
    const s = memStores({
      processed: { [pull.packetId]: { driverId: 'drv-a', wellName: 'Gab 1' } },
    });
    await expect(
      applyFieldCommandMutation(s, {
        type: 'pull',
        packetId: pull.packetId,
        stamped: { ...pull, companyId: 'liquid-gold' },
        driver,
        manager: false,
      }),
    ).rejects.toThrow(/packet_collision/);
  });
});

describe('edit/delete ownership and exact target', () => {
  it('deletes only the authorized original, never the delete command packetId', async () => {
    const original = '20260816_110000_WellA_orig99';
    const deleteId = '20260816_130000_WellA_del01';
    const s = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          tankLevelFeet: 12,
          bblsTaken: 80,
          dateTimeUTC: '2026-08-16T16:00:00.000Z',
        },
      },
    });
    const r = await applyFieldCommandMutation(s, {
      type: 'delete',
      packetId: deleteId,
      originalPacketId: original,
      stamped: { requestType: 'delete', packetId: deleteId, originalPacketId: original, wellName: 'Gab 1', companyId: 'liquid-gold' },
      driver,
      manager: false,
    });
    expect(r.targetPacketId).toBe(original);
    expect(s.deletedTargets).toEqual([original]);
    expect(s.processed[deleteId]).toBeUndefined();
    expect(s.processed[original].deleted).toBe(true);
  });

  it('edits the original processed packet', async () => {
    const original = '20260816_110000_WellA_orig99';
    const s = memStores({
      processed: {
        [original]: { driverId: 'drv-a', companyId: 'liquid-gold', wellName: 'Gab 1', tankLevelFeet: 12 },
      },
    });
    await applyFieldCommandMutation(s, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: {
        ...pull,
        requestType: 'edit',
        packetId: `edit_${original}`,
        originalPacketId: original,
        tankLevelFeet: 10,
        companyId: 'liquid-gold',
      },
      driver,
      manager: false,
    });
    expect(s.processed[original].tankLevelFeet).toBe(10);
    expect(s.processed[original].editedBy).toBeUndefined();
    expect(s.processed[original].requestType).toBe('pull');
    expect(s.processed[`edit_${original}`]).toBeUndefined();
  });
});

describe('canonical receipt lease', () => {
  const intended = {
    driverId: 'drv-a',
    companyId: 'liquid-gold',
    type: 'pull' as const,
    targetPacketId: pull.packetId,
    digest: contentDigest({ tankLevelFeet: 12, bblsTaken: 80 }),
    nowMs: 1000,
  };

  it('binds the receipt to company+type+target+digest, not a client idempotency key', () => {
    const a = canonicalReceiptKey({
      companyId: 'liquid-gold',
      type: 'pull',
      targetPacketId: pull.packetId,
      digest: contentDigest({ tankLevelFeet: 1 }),
    });
    const b = canonicalReceiptKey({
      companyId: 'liquid-gold',
      type: 'pull',
      targetPacketId: pull.packetId,
      digest: contentDigest({ tankLevelFeet: 2 }),
    });
    expect(a).not.toBe(b);
  });

  it('makes a live lease exclusive even for the same driver', () => {
    expect(
      decideLease(
        {
          exists: true,
          ...intended,
          status: 'leased',
          leaseOwner: 'drv-a',
          leaseUntil: 5000,
        },
        intended,
      ).action,
    ).toBe('collision');
  });

  it('resumes after lease expiry or applied, duplicates committed', () => {
    expect(
      decideLease(
        { exists: true, ...intended, status: 'leased', leaseUntil: 500 },
        intended,
      ).action,
    ).toBe('resume');
    expect(
      decideLease({ exists: true, ...intended, status: 'applied' }, intended).action,
    ).toBe('resume');
    expect(
      decideLease({ exists: true, ...intended, status: 'committed' }, intended).action,
    ).toBe('resume');
    expect(
      decideLease(
        { exists: true, ...intended, status: 'committed', markersPublished: true },
        intended,
      ).action,
    ).toBe('duplicate');
  });

  it('plans crash recovery at every receipt boundary', () => {
    expect(nextLeaseApplyPlan({ exists: true, status: 'leased' })).toBe('apply');
    expect(nextLeaseApplyPlan({ exists: true, status: 'applied' })).toBe('increment_only');
    expect(
      nextLeaseApplyPlan({ exists: true, status: 'applied', versionIncremented: true }),
    ).toBe('commit_only');
    expect(nextLeaseApplyPlan({ exists: true, status: 'committed' })).toBe('markers_only');
    expect(nextLeaseApplyPlan({ exists: true, status: 'committed', markersPublished: true })).toBe('duplicate');
    expect(
      decideLease(
        { exists: true, ...intended, status: 'committed', markersPublished: true },
        intended,
      ).action,
    ).toBe('duplicate');
    expect(
      decideLease(
        { exists: true, ...intended, status: 'committed', markersPublished: false },
        intended,
      ).action,
    ).toBe('resume');
    expect(decideVersionAck(null)).toEqual({ writeAck: true, increment: true });
    expect(decideVersionAck({ at: 1 })).toEqual({ writeAck: false, increment: false });
  });
});

describe('concurrent version increments', () => {
  it('transactional increment never concatenates and is race-safe when serialized', () => {
    let v: unknown = '85';
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      v = incrementIncomingVersionValue(v);
      expect(v).toBe(String(86 + i));
      expect(seen.has(String(v))).toBe(false);
      seen.add(String(v));
    }
    expect(incrementIncomingVersionValue(undefined)).toBe('1');
    expect(incrementIncomingVersionValue('not-a-number')).toBe('1');
  });
});

describe('atomic rate limit', () => {
  it('cannot be bypassed by concurrent windows', () => {
    let win = null as ReturnType<typeof nextRateWindow>['next'] | null;
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 12; i++) {
      const r = nextRateWindow(win, 1000, 10_000, 5);
      win = r.next;
      if (r.allowed) allowed++;
      else denied++;
    }
    expect(allowed).toBe(5);
    expect(denied).toBe(7);
  });
});

describe('committed well-down and company-scoped outgoing', () => {
  it('ignores a non-manager wellDown:false + wellDownIsAuthoritative and uses RTDB', async () => {
    const s = memStores({ wellDown: true });
    const r = await applyFieldCommandMutation(s, {
      type: 'pull',
      packetId: pull.packetId,
      stamped: { ...pull, wellDown: false, wellDownIsAuthoritative: true },
      driver,
      manager: false,
    });
    expect(r.wellDown).toBe(true);
    expect(s.processed[pull.packetId].wellDown).toBe(true);
    expect(s.outgoing[r.outgoingId!].wellDown).toBe(true);
    expect(s.outgoing[r.outgoingId!].currentLevel).not.toMatch(/Calculating/);
    expect(s.outgoing[r.outgoingId!].bbls24hrs).not.toBe('Calculating…');
  });

  it('rejects edit wellName that does not match the original packet', async () => {
    const original = '20260816_110000_WellA_orig99';
    const s = memStores({
      processed: {
        [original]: { driverId: 'drv-a', companyId: 'liquid-gold', wellName: 'Gab 1' },
      },
    });
    await expect(
      applyFieldCommandMutation(s, {
        type: 'edit',
        packetId: `edit_${original}`,
        originalPacketId: original,
        stamped: { ...pull, wellName: 'Other Well', tankLevelFeet: 9 },
        driver,
        manager: false,
      }),
    ).rejects.toThrow(/well_mismatch/);
  });

  it('does not delete another company outgoing row with the same well name', async () => {
    const s = memStores();
    s.outgoing['response_otherco'] = { wellName: 'Gab 1', companyId: 'acme-eog-test' };
    await applyFieldCommandMutation(s, {
      type: 'pull',
      packetId: pull.packetId,
      stamped: { ...pull, companyId: 'liquid-gold' },
      driver,
      manager: false,
    });
    expect(s.outgoing['response_otherco'].companyId).toBe('acme-eog-test');
  });

  it('updates linked invoice and dispatch on edit', async () => {
    const original = '20260816_110000_WellA_orig99';
    const s = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          invoiceDocId: 'INV_1',
          dispatchId: 'DSP_1',
          tankLevelFeet: 12,
        },
      },
    });
    s.invoices.INV_1 = { companyId: 'liquid-gold', lastPullPacketId: original };
    s.dispatches.DSP_1 = { companyId: 'liquid-gold', lastPullPacketId: original };
    await applyFieldCommandMutation(s, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40, invoiceDocId: 'INV_1', dispatchId: 'DSP_1' },
      driver,
      manager: false,
    });
    expect(s.invoices.INV_1.tankLevelFeet).toBe(8);
    expect(s.dispatches.DSP_1.tankLevelFeet).toBe(8);
    expect(s.processed[original].wasEdited).toBeUndefined();
    expect(s.processed[original].editedAt).toBeUndefined();
    expect(s.processed[original].requestType).toBe('pull');
    expect(s.processed[original].invoiceDocId).toBe('INV_1');
    expect(s.outgoing[Object.keys(s.outgoing)[0]].isEdit).toBe(false);
  });

  it('ignores client invoiceDocId on edit and fails if the linked invoice is missing', async () => {
    const original = '20260816_110000_WellA_orig99';
    const s = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          invoiceDocId: 'INV_MISSING',
          tankLevelFeet: 12,
        },
      },
    });
    await expect(
      applyFieldCommandMutation(s, {
        type: 'edit',
        packetId: `edit_${original}`,
        originalPacketId: original,
        stamped: { ...pull, invoiceDocId: 'INV_FORGED', tankLevelFeet: 8 },
        driver,
        manager: false,
      }),
    ).rejects.toThrow(/linked_missing/);
    expect(s.processed[original].invoiceDocId).toBe('INV_MISSING');
  });
});

describe('crash injection at every write boundary', () => {
  const effects: FieldEffectName[] = ['processed', 'outgoing'];

  function receiptBackedStores(failAfter?: FieldEffectName | `${FieldEffectName}_before_persist`) {
    const receipt: { doneEffects: Record<string, true> } = { doneEffects: {} };
    const s = memStores();
    s.persistEffect = async (name) => {
      receipt.doneEffects[name] = true;
    };
    return { s, receipt, failAfter };
  }

  it('retries from the persisted receipt only — never the exception map', async () => {
    for (const failAfter of effects) {
      const { s, receipt } = receiptBackedStores(failAfter);
      try {
        await applyFieldCommandMutation(s, {
          type: 'pull',
          packetId: pull.packetId,
          stamped: { ...pull, companyId: 'liquid-gold' },
          driver,
          manager: false,
          skipVersionIncrement: true,
          failAfter,
        });
      } catch (e) {
        expect(e).toBeInstanceOf(FieldApplyInterrupt);
        // Deliberately ignore exception-carried map.
      }
      const second = await applyFieldCommandMutation(s, {
        type: 'pull',
        packetId: pull.packetId,
        stamped: { ...pull, companyId: 'liquid-gold' },
        driver,
        manager: false,
        skipVersionIncrement: true,
        doneEffects: { ...receipt.doneEffects },
      });
      expect(s.processed[pull.packetId].companyId).toBe('liquid-gold');
      expect(s.outgoing[second.outgoingId!].companyId).toBe('liquid-gold');
      expect(Object.keys(s.outgoing)).toHaveLength(1);
    }
  });

  it('preflight of a missing invoice leaves processed/outgoing unchanged', async () => {
    const original = '20260816_110000_WellA_preflight';
    const s = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          invoiceDocId: 'INV_GONE',
          tankLevelFeet: 12,
        },
      },
    });
    const before = JSON.stringify(s.processed[original]);
    await expect(
      applyFieldCommandMutation(s, {
        type: 'edit',
        packetId: `edit_${original}`,
        originalPacketId: original,
        stamped: { ...pull, tankLevelFeet: 8 },
        driver,
        manager: false,
      }),
    ).rejects.toThrow(/linked_missing/);
    expect(JSON.stringify(s.processed[original])).toBe(before);
    expect(s.processed[original].wasEdited).toBeUndefined();
    expect(Object.keys(s.outgoing)).toHaveLength(0);
  });

  it('does not write any edit badge during apply, even after outgoing', async () => {
    const original = '20260816_110000_WellA_badge';
    const s = memStores({
      processed: {
        [original]: { driverId: 'drv-a', companyId: 'liquid-gold', wellName: 'Gab 1', tankLevelFeet: 12, requestType: 'pull' },
      },
    });
    try {
      await applyFieldCommandMutation(s, {
        type: 'edit',
        packetId: `edit_${original}`,
        originalPacketId: original,
        stamped: { ...pull, tankLevelFeet: 8 },
        driver,
        manager: false,
        skipVersionIncrement: true,
        failAfter: 'outgoing',
      });
    } catch {
      /* expected */
    }
    expect(s.processed[original].wasEdited).toBeUndefined();
    expect(s.processed[original].editedAt).toBeUndefined();
    expect(s.processed[original].editedByPacketId).toBeUndefined();
    expect(s.processed[original].requestType).toBe('pull');
    await applyFieldCommandMutation(s, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8 },
      driver,
      manager: false,
      skipVersionIncrement: true,
      doneEffects: { processed: true, outgoing: true },
    });
    expect(s.processed[original].wasEdited).toBeUndefined();
    expect(s.processed[original].editCommitted).toBeUndefined();
    expect(s.processed[original].requestType).toBe('pull');
  });

  it('incoming_version_state increments once per receipt key', () => {
    let state: unknown = '10';
    const a = applyIncomingVersionState(state, 'k1');
    state = a.next;
    const b = applyIncomingVersionState(state, 'k1');
    expect(a.next.value).toBe('11');
    expect(b.already).toBe(true);
    expect(b.next.value).toBe('11');
    const c = applyIncomingVersionState(state, 'k2');
    expect(c.next.value).toBe('12');
  });
});
