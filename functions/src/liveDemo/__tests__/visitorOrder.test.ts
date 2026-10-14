import { parseVisitorOrder } from '../visitorOrder';

const valid = {
  pickup: 'Demo Well 2', destination: 'Demo SWD 1',
  driverAlias: 'demo-driver-claude', loadCount: 2,
};

describe('public demo visitor order boundary', () => {
  it('accepts only catalog-backed demo choices and at most three loads', () => {
    expect(parseVisitorOrder(valid)).toEqual(valid);
    expect(parseVisitorOrder({ ...valid, loadCount: 3 }).loadCount).toBe(3);
    expect(() => parseVisitorOrder({ ...valid, loadCount: 4 })).toThrow('invalid_demo_load_count');
    expect(() => parseVisitorOrder({ ...valid, loadCount: 1e9 })).toThrow('invalid_demo_load_count');
    expect(() => parseVisitorOrder({ ...valid, loadCount: '2' })).toThrow('invalid_demo_load_count');
  });

  it('rejects company, operator, custom place and driver overrides', () => {
    expect(() => parseVisitorOrder({ ...valid, companyId: 'liquid-gold' })).toThrow('invalid_demo_order_fields');
    expect(() => parseVisitorOrder({ ...valid, operator: 'Slawson' })).toThrow('invalid_demo_order_fields');
    expect(() => parseVisitorOrder({ ...valid, pickup: 'Real Well' })).toThrow('invalid_demo_pickup');
    expect(() => parseVisitorOrder({ ...valid, destination: 'Real SWD' })).toThrow('invalid_demo_destination');
    expect(() => parseVisitorOrder({ ...valid, driverAlias: 'real-driver' })).toThrow('invalid_demo_driver');
  });
});
