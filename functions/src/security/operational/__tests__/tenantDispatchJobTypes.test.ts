import {
  evaluateTenantCallerAccess,
  validateDispatchJobTypesPayload,
  MAX_DISPATCH_JOB_TYPES,
  MAX_JOB_TYPE_NAME_LENGTH,
  MAX_JOB_TYPE_ID_LENGTH,
  type DispatchJobTypeConfig,
  type DispatchJobTypeEntry,
  type TenantCaller,
} from '../tenantDispatchJobTypes';

describe('tenantDispatchJobTypes — server authorization & validation', () => {
  const validEntry1: DispatchJobTypeEntry = {
    id: 'pw-default',
    code: 'PW',
    name: 'Production Water',
    workClass: 'pw',
    enabled: true,
    order: 0,
  };

  const validEntry2: DispatchJobTypeEntry = {
    id: 'sw-default',
    code: 'SW',
    name: 'Service Work',
    workClass: 'sw',
    enabled: true,
    order: 1,
  };

  const validConfig: DispatchJobTypeConfig = {
    version: 1,
    items: [validEntry1, validEntry2],
  };

  describe('evaluateTenantCallerAccess', () => {
    it('denies unauthenticated caller', () => {
      const res = evaluateTenantCallerAccess(null, 'company-123');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('unauthenticated');
    });

    it('denies caller with empty uid', () => {
      const caller: TenantCaller = {
        uid: '',
        roles: ['admin'],
        companyId: 'company-123',
        caps: ['manageCompany'],
        isPlatformAdmin: false,
      };
      const res = evaluateTenantCallerAccess(caller, 'company-123');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('unauthenticated');
    });

    it('denies missing target company ID', () => {
      const caller: TenantCaller = {
        uid: 'user-1',
        roles: ['admin'],
        companyId: 'company-123',
        caps: ['manageCompany'],
        isPlatformAdmin: false,
      };
      const res = evaluateTenantCallerAccess(caller, '');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('missing_target_company_id');
    });

    it('denies tenant caller with no companyId', () => {
      const caller: TenantCaller = {
        uid: 'user-1',
        roles: ['admin'],
        companyId: null,
        caps: ['manageCompany'],
        isPlatformAdmin: false,
      };
      const res = evaluateTenantCallerAccess(caller, 'company-123');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('caller_has_no_company');
    });

    it('denies wrong-company attempt (cross-company target)', () => {
      const caller: TenantCaller = {
        uid: 'user-1',
        roles: ['admin'],
        companyId: 'company-aaa',
        caps: ['manageCompany'],
        isPlatformAdmin: false,
      };
      const res = evaluateTenantCallerAccess(caller, 'company-bbb');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('cross_company_target_denied');
        expect(res.field).toBe('company-bbb');
      }
    });

    it('denies same-company caller lacking manageCompany capability', () => {
      const caller: TenantCaller = {
        uid: 'user-1',
        roles: ['dispatch'],
        companyId: 'company-123',
        caps: ['createDispatch', 'viewDispatch'],
        isPlatformAdmin: false,
      };
      const res = evaluateTenantCallerAccess(caller, 'company-123');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('lacks_manage_company_capability');
    });

    it('authorizes valid same-company caller holding manageCompany capability', () => {
      const caller: TenantCaller = {
        uid: 'user-admin',
        roles: ['admin'],
        companyId: 'company-123',
        caps: ['manageCompany', 'manageDrivers'],
        isPlatformAdmin: false,
      };
      const res = evaluateTenantCallerAccess(caller, 'company-123');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.targetCompanyId).toBe('company-123');
        expect(res.isPlatformAdmin).toBe(false);
      }
    });

    it('authorizes platform admin targeting any company explicitly', () => {
      const platformAdminCaller: TenantCaller = {
        uid: 'platform-admin-1',
        roles: ['admin', 'it'],
        companyId: null,
        caps: ['viewAllCompanies'],
        isPlatformAdmin: true,
      };
      const res = evaluateTenantCallerAccess(platformAdminCaller, 'target-any-company-999');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.targetCompanyId).toBe('target-any-company-999');
        expect(res.isPlatformAdmin).toBe(true);
      }
    });
  });

  describe('validateDispatchJobTypesPayload', () => {
    it('accepts valid configuration and normalizes integer order', () => {
      const res = validateDispatchJobTypesPayload(validConfig);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.payload.version).toBe(1);
        expect(res.payload.items.length).toBe(2);
        expect(res.payload.items[0].order).toBe(0);
        expect(res.payload.items[1].order).toBe(1);
      }
    });

    it('rejects non-object payload', () => {
      expect(validateDispatchJobTypesPayload(null).ok).toBe(false);
      expect(validateDispatchJobTypesPayload('string').ok).toBe(false);
      expect(validateDispatchJobTypesPayload([1, 2, 3]).ok).toBe(false);
    });

    it('rejects unsupported version', () => {
      const res = validateDispatchJobTypesPayload({ version: 2, items: [validEntry1] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('unsupported_version');
    });

    it('rejects non-array items', () => {
      const res = validateDispatchJobTypesPayload({ version: 1, items: 'not an array' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('items_must_be_array');
    });

    it('rejects empty items array', () => {
      const res = validateDispatchJobTypesPayload({ version: 1, items: [] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('items_empty');
    });

    it('rejects oversized payload exceeding MAX_DISPATCH_JOB_TYPES (50)', () => {
      const items: DispatchJobTypeEntry[] = [];
      for (let i = 0; i < MAX_DISPATCH_JOB_TYPES + 1; i++) {
        const c1 = String.fromCharCode(65 + Math.floor(i / 26));
        const c2 = String.fromCharCode(65 + (i % 26));
        items.push({
          id: `id-${i}`,
          code: `${c1}${c2}`,
          name: `Type ${i}`,
          workClass: 'pw',
          enabled: true,
          order: i,
        });
      }
      const res = validateDispatchJobTypesPayload({ version: 1, items });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('items_exceed_limit');
    });

    it('rejects duplicate IDs', () => {
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [
          { ...validEntry1, id: 'dup-id' },
          { ...validEntry2, id: 'dup-id' },
        ],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('duplicate_id');
        expect(res.field).toBe('dup-id');
      }
    });

    it('rejects invalid or empty ID', () => {
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [{ ...validEntry1, id: '   ' }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('id_length_out_of_bounds');
    });

    it('rejects ID exceeding MAX_JOB_TYPE_ID_LENGTH (64)', () => {
      const longId = 'a'.repeat(MAX_JOB_TYPE_ID_LENGTH + 1);
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [{ ...validEntry1, id: longId }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('id_length_out_of_bounds');
    });

    it('rejects ID with invalid characters', () => {
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [{ ...validEntry1, id: 'bad ID with spaces!' }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('id_invalid_characters');
    });

    it('rejects code that is not exactly 2 uppercase letters', () => {
      for (const badCode of ['P', 'PW1', 'PWW', 'pw', 'P1', '12', '', '  ']) {
        const res = validateDispatchJobTypesPayload({
          version: 1,
          items: [{ ...validEntry1, code: badCode }],
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('code_must_be_two_uppercase_letters');
      }
    });

    it('rejects duplicate codes (case-insensitive check)', () => {
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [
          { ...validEntry1, code: 'PW' },
          { ...validEntry2, id: 'sw-diff', code: 'PW' },
        ],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('duplicate_code');
        expect(res.field).toBe('PW');
      }
    });

    it('rejects empty or whitespace-only display name', () => {
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [{ ...validEntry1, name: '   ' }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('name_length_out_of_bounds');
    });

    it('rejects display name exceeding MAX_JOB_TYPE_NAME_LENGTH (60)', () => {
      const longName = 'A'.repeat(MAX_JOB_TYPE_NAME_LENGTH + 1);
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [{ ...validEntry1, name: longName }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('name_length_out_of_bounds');
    });

    it('rejects duplicate display names (case-insensitive check)', () => {
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [
          { ...validEntry1, name: 'Production Water' },
          { ...validEntry2, name: 'production water' },
        ],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('duplicate_name');
        expect(res.field).toBe('production water');
      }
    });

    it('rejects invalid workClass (strictly "pw" or "sw")', () => {
      for (const badClass of ['dirty', 'dw', 'other', 'PW', 'SW', '']) {
        const res = validateDispatchJobTypesPayload({
          version: 1,
          items: [{ ...validEntry1, workClass: badClass as any }],
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('invalid_work_class');
      }
    });

    it('rejects non-boolean enabled', () => {
      for (const badEnabled of ['true', 1, null, undefined]) {
        const res = validateDispatchJobTypesPayload({
          version: 1,
          items: [{ ...validEntry1, enabled: badEnabled as any }],
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('invalid_enabled');
      }
    });

    it('rejects payload where zero items are enabled', () => {
      const res = validateDispatchJobTypesPayload({
        version: 1,
        items: [
          { ...validEntry1, enabled: false },
          { ...validEntry2, enabled: false },
        ],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('at_least_one_item_must_be_enabled');
    });

    it('allows single-class configurations (all PW or all SW)', () => {
      const allPw = validateDispatchJobTypesPayload({
        version: 1,
        items: [
          { ...validEntry1, id: 'pw-1', code: 'PW', name: 'Production Water', workClass: 'pw' },
          { ...validEntry2, id: 'pw-2', code: 'FW', name: 'Fresh Water', workClass: 'pw' },
        ],
      });
      expect(allPw.ok).toBe(true);

      const allSw = validateDispatchJobTypesPayload({
        version: 1,
        items: [
          { ...validEntry1, id: 'sw-1', code: 'SW', name: 'Service Work', workClass: 'sw' },
          { ...validEntry2, id: 'sw-2', code: 'MT', name: 'Maintenance', workClass: 'sw' },
        ],
      });
      expect(allSw.ok).toBe(true);
    });
  });
});
