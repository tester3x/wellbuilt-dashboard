import {
  PUBLIC_COMPANY_COPIED_FIELDS,
  PUBLIC_COMPANY_SENSITIVE_NEVER,
  PUBLIC_COMPANY_WHITELIST,
  buildPublicCompanyDocument,
  isPublicCompanySensitiveKey,
  isStrictPublicCompanyDocument,
  projectPublicCompanyFields,
} from '../publicCompanyProjection';

const FAT_SOURCE: Record<string, unknown> = {
  name: 'Liquid Gold',
  status: 'active',
  tier: 'god',
  logoUrl: 'https://example.test/logo.png',
  thermalLogoUrl: 'https://example.test/thermal.png',
  primaryColor: '#C8A415',
  updatedAt: 'SOURCE-STAMP-MUST-NOT-COPY',
  address: 'P.O. Box 4447',
  city: 'Williston',
  state: 'ND',
  zip: '58801',
  phone: '(701) 730-5409',
  rateSheet: { waterHaulPerBBL: 1.25 },
  rateSheets: { SLAWSON: [{ jobType: 'Production Water', rate: 1.1 }] },
  payConfig: { defaultSplit: 0.25 },
  billingConfig: { SLAWSON: { paymentTerms: 'net_30' } },
  currentDieselPrice: 3.89,
  doeRegion: 'padd2',
  roleCapabilities: { dispatcher: ['viewDispatch'] },
  roleLabels: { dispatcher: 'Coordinator' },
  wellbuiltContract: { contractVersion: 1, planId: 'plan-field' },
  contractVersion: 1,
  planId: 'plan-field',
  entitlement: 'god',
  spillReporting: { notifyPolicy: { recipients: ['secret@x'] } },
  emergencyContacts: [{ label: '911', phone: '911' }],
  companyContacts: [{ label: 'Office', phone: '555' }],
  assignedOperators: ['SLAWSON'],
  ticketTemplates: { water: { companyName: true } },
  activePackages: ['water-hauling'],
  customJobTypes: [{ label: 'Vac', packages: ['water-hauling'] }],
  invoicingMode: 'invoice_tickets',
  invoicePrefix: 'LG',
  liveDispatchSync: true,
  jsaMode: 'per_job',
  wellMonitoring: true,
  enabledApps: ['wbt', 'wbm'],
  adminUsers: ['uid-1'],
  notes: 'internal',
};

describe('public company whitelist is exact', () => {
  test('copied fields are the six branding/identity strings', () => {
    expect([...PUBLIC_COMPANY_COPIED_FIELDS]).toEqual([
      'name',
      'status',
      'tier',
      'logoUrl',
      'thermalLogoUrl',
      'primaryColor',
    ]);
  });

  test('whitelist is copied fields plus writer-owned updatedAt', () => {
    expect([...PUBLIC_COMPANY_WHITELIST]).toEqual([
      'name',
      'status',
      'tier',
      'logoUrl',
      'thermalLogoUrl',
      'primaryColor',
      'updatedAt',
    ]);
  });

  test('every sensitive field is classified never-public', () => {
    for (const key of [
      'address',
      'phone',
      'rateSheet',
      'rateSheets',
      'payConfig',
      'billingConfig',
      'roleCapabilities',
      'wellbuiltContract',
      'emergencyContacts',
      'assignedOperators',
      'ticketTemplates',
      'invoicingMode',
      'jsaMode',
      'liveDispatchSync',
    ]) {
      expect(isPublicCompanySensitiveKey(key)).toBe(true);
    }
  });

  test('no whitelist field is on the sensitive-never list', () => {
    for (const key of PUBLIC_COMPANY_WHITELIST) {
      expect(PUBLIC_COMPANY_SENSITIVE_NEVER).not.toContain(key);
    }
  });
});

describe('projectPublicCompanyFields — whitelist only', () => {
  test('copies only allowlisted strings from a fat source document', () => {
    const projected = projectPublicCompanyFields(FAT_SOURCE);
    expect(projected).toEqual({
      name: 'Liquid Gold',
      status: 'active',
      tier: 'god',
      logoUrl: 'https://example.test/logo.png',
      thermalLogoUrl: 'https://example.test/thermal.png',
      primaryColor: '#C8A415',
    });
  });

  test('drops every sensitive field', () => {
    const projected = projectPublicCompanyFields(FAT_SOURCE) as Record<string, unknown>;
    for (const key of PUBLIC_COMPANY_SENSITIVE_NEVER) {
      expect(projected).not.toHaveProperty(key);
    }
    expect(projected).not.toHaveProperty('updatedAt');
  });

  test('omits missing, empty, and non-string allowlisted fields', () => {
    expect(
      projectPublicCompanyFields({
        name: 'Acme',
        status: '',
        tier: 3,
        logoUrl: null,
        primaryColor: undefined,
      }),
    ).toEqual({ name: 'Acme' });
  });

  test('empty source yields empty projection (no leftover keys)', () => {
    expect(projectPublicCompanyFields({})).toEqual({});
    expect(projectPublicCompanyFields(null)).toEqual({});
    expect(projectPublicCompanyFields(undefined)).toEqual({});
  });
});

describe('buildPublicCompanyDocument — field removal + writer stamp', () => {
  test('full document is whitelist-only and uses writer updatedAt', () => {
    const stamp = { sentinel: 'writer-now' };
    const doc = buildPublicCompanyDocument(FAT_SOURCE, stamp) as Record<string, unknown>;
    expect(isStrictPublicCompanyDocument(doc)).toBe(true);
    expect(doc.updatedAt).toBe(stamp);
    expect(doc.updatedAt).not.toBe(FAT_SOURCE.updatedAt);
    for (const key of PUBLIC_COMPANY_SENSITIVE_NEVER) {
      expect(doc).not.toHaveProperty(key);
    }
  });

  test('removing a source field removes it from the replacement payload', () => {
    const before = buildPublicCompanyDocument(FAT_SOURCE, 't1') as Record<string, unknown>;
    expect(before.logoUrl).toBe('https://example.test/logo.png');
    const afterSource = { ...FAT_SOURCE };
    delete afterSource.logoUrl;
    delete afterSource.thermalLogoUrl;
    const after = buildPublicCompanyDocument(afterSource, 't2') as Record<string, unknown>;
    expect(after).not.toHaveProperty('logoUrl');
    expect(after).not.toHaveProperty('thermalLogoUrl');
    expect(after.name).toBe('Liquid Gold');
    expect(after.updatedAt).toBe('t2');
  });
});
