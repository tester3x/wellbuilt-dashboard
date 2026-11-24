import { assertIndependentJobMutable, independentJobTransition, parseIndependentJob } from '../independentDispatchJobs';
import { INDEPENDENT_SECTORS, parseSectorFields } from '../independentDispatchSectors';

describe('Independent Dispatch job validation and lifecycle', () => {
  const job = { title: 'Pipe delivery', customer: 'Customer', pickup: 'Yard', destination: 'Site' };
  it('supports jobs without wells, water, accounts, or ticket fields', () => {
    expect(parseIndependentJob(job)).toEqual({ ...job, reference: '', cargo: '', scheduledAt: '', estimatedEndAt: '', notes: '',
      jobContactName: '', jobContactRole: '', jobContactPhoneE164: '', shift: '', ongoing: false, requestedDriverCount: null });
  });
  it('rejects injected tenant, status, and identity fields', () => {
    for (const field of ['companyId', 'driverId', 'status', 'revision', 'wellName', '__proto__']) {
      const raw = JSON.parse(JSON.stringify(job));
      Object.defineProperty(raw, field, { value: 'forged', enumerable: true });
      expect(() => parseIndependentJob(raw)).toThrow();
    }
  });
  it('requires actual locations and customer, limits notes, and validates UTC dates', () => {
    expect(parseIndependentJob({ ...job, pickup: '  ' }).pickup).toBe('');
    expect(parseIndependentJob({ ...job, destination: '' }).pickup).toBe('Yard');
    expect(() => parseIndependentJob({ ...job, pickup: '  ', destination: '' })).toThrow('required_location');
    expect(parseIndependentJob({ ...job, pickup: '', destination: '', additionalStops: ['  Rig 5  '] }).additionalStops).toEqual(['Rig 5']);
    expect(() => parseIndependentJob({ ...job, additionalStops: [''] })).toThrow('invalid_additionalStops');
    expect(() => parseIndependentJob({ ...job, additionalStops: Array(13).fill('Site') })).toThrow('invalid_additionalStops');
    expect(() => parseIndependentJob({ ...job, notes: 'a'.repeat(4001) })).toThrow();
    expect(() => parseIndependentJob({ ...job, scheduledAt: '2026-02-30T12:00:00.000Z' })).toThrow();
    expect(parseIndependentJob({ ...job, scheduledAt: '2026-11-20T12:00:00.000Z' }).scheduledAt).toContain('2026-11-20');
    expect(parseIndependentJob({ ...job, jobContactName: 'John Wick', jobContactRole: 'Company man', jobContactPhoneE164: '+17015550123' }))
      .toMatchObject({ jobContactName: 'John Wick', jobContactPhoneE164: '+17015550123' });
    expect(() => parseIndependentJob({ ...job, jobContactPhoneE164: '+17015550123' })).toThrow('required_job_contact_name');
    expect(() => parseIndependentJob({ ...job, jobContactName: 'John Wick', jobContactPhoneE164: '701-555-0123' })).toThrow('invalid_job_contact_phone');
  });
  it('validates estimated finish, shift, and ongoing work', () => {
    const scheduledAt = '2026-11-23T08:00:00.000Z';
    expect(parseIndependentJob({ ...job, scheduledAt, estimatedEndAt: '2026-11-23T20:00:00.000Z', shift: 'day', ongoing: true }))
      .toMatchObject({ shift: 'day', ongoing: true });
    expect(() => parseIndependentJob({ ...job, estimatedEndAt: '2026-11-23T20:00:00.000Z' })).toThrow('invalid_estimatedEndAt');
    expect(() => parseIndependentJob({ ...job, scheduledAt, estimatedEndAt: scheduledAt })).toThrow('invalid_estimatedEndAt');
    expect(() => parseIndependentJob({ ...job, shift: 'swing' })).toThrow('invalid_shift');
    expect(() => parseIndependentJob({ ...job, ongoing: 'true' })).toThrow('invalid_ongoing');
  });
  it('stores an optional requested crew size separately from assignments', () => {
    expect(parseIndependentJob({ ...job, requestedDriverCount: 3 }).requestedDriverCount).toBe(3);
    expect(parseIndependentJob({ ...job, requestedDriverCount: null }).requestedDriverCount).toBeNull();
    for (const requestedDriverCount of [0, 31, 2.5, '3']) {
      expect(() => parseIndependentJob({ ...job, requestedDriverCount })).toThrow('invalid_requestedDriverCount');
    }
  });
  it('cannot complete unassigned work or reopen terminal jobs', () => {
    expect(independentJobTransition('unassigned', 'completed')).toBe(false);
    expect(independentJobTransition('assigned', 'in_progress')).toBe(true);
    expect(independentJobTransition('in_progress', 'completed')).toBe(true);
    expect(independentJobTransition('completed', 'assigned')).toBe(false);
    expect(independentJobTransition('cancelled', 'assigned')).toBe(false);
    expect(() => assertIndependentJobMutable('in_progress')).toThrow();
  });
  it('accepts five distinct sector forms while retaining old generic jobs', () => {
    const examples: Record<string, Record<string, string>> = {
      'water-hauling': { waterType: 'Fresh water', volumeBbl: '120' },
      ltl: { freightDescription: 'Palletized parts', pieces: '12' },
      otr: { trailerType: 'Dry van', commodity: 'Equipment' },
      'hot-shot': { urgency: 'Same day', cargoDetails: 'Pump skid' },
      aggregate: { material: 'Gravel', estimatedTons: '24.5' },
    };
    for (const sector of INDEPENDENT_SECTORS) {
      const parsed = parseIndependentJob({ ...job, customerId: 'customer-a', sector, sectorFields: examples[sector] });
      expect(parsed.sector).toBe(sector);
      expect(parsed.sectorFields).toMatchObject(examples[sector]);
      const oneOff = parseIndependentJob({ ...job, sector, sectorFields: examples[sector] });
      expect(oneOff.customerId).toBeUndefined();
      expect(oneOff.sector).toBe(sector);
    }
    expect(parseIndependentJob(job).sector).toBeUndefined();
    expect(parseIndependentJob({ ...job, shift: 'both', ongoing: true })).toMatchObject({ shift: 'both', ongoing: true });
  });
  it('rejects mixed-sector fields, missing required details, and injected fields', () => {
    expect(() => parseSectorFields('ltl', { freightDescription: 'Parts', pieces: '2', waterType: 'PW' })).toThrow('unexpected_sector_field');
    expect(() => parseSectorFields('aggregate', { material: 'Sand' })).toThrow('required_estimatedTons');
    expect(() => parseIndependentJob({ ...job, customerId: 'customer-a', sector: 'otr', sectorFields: { trailerType: 'Dry van', commodity: 'Steel', weightLbs: '-10' } })).toThrow('invalid_weightLbs');
  });
  it('requires a saved customer and sector before using a profile category', () => {
    const water = { ...job, customerId: 'exxon', sector: 'water-hauling',
      sectorFields: { waterType: 'Fresh water', volumeBbl: '120' } };
    expect(parseIndependentJob({ ...water, categoryId: 'rig-work', asset: 'H&P Rig 429' }))
      .toMatchObject({ categoryId: 'rig-work', asset: 'H&P Rig 429' });
    expect(parseIndependentJob({ ...water, categoryId: '', asset: '' })).toMatchObject({ categoryId: '', asset: '' });
    expect(() => parseIndependentJob({ ...water, categoryId: '', asset: 'H&P Rig 429' })).toThrow('asset_requires_category');
    expect(() => parseIndependentJob({ ...job, categoryId: 'rig-work' })).toThrow('invalid_categoryId');
    expect(() => parseIndependentJob({ ...water, categoryId: 'bad/id' })).toThrow('invalid_categoryId');
    expect(() => parseIndependentJob({ ...water, asset: 'H&P Rig 429' })).toThrow('invalid_categoryId');
  });
});
