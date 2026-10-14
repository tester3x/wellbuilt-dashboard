import { DEMO_DESTINATIONS, DEMO_DRIVERS, DEMO_WELLS } from './plan';

/** Public visitors submit choices, never a Firestore dispatch document. */
export type VisitorOrder = {
  pickup: typeof DEMO_WELLS[number];
  destination: typeof DEMO_DESTINATIONS[number];
  driverAlias: typeof DEMO_DRIVERS[number]['id'];
  loadCount: number;
};

export function parseVisitorOrder(value: unknown): VisitorOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_demo_order');
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== 4 || keys.some(key => !['pickup', 'destination', 'driverAlias', 'loadCount'].includes(key))) {
    throw new Error('invalid_demo_order_fields');
  }
  if (typeof raw.pickup !== 'string' || !DEMO_WELLS.includes(raw.pickup as VisitorOrder['pickup'])) {
    throw new Error('invalid_demo_pickup');
  }
  if (typeof raw.destination !== 'string' || !DEMO_DESTINATIONS.includes(raw.destination as VisitorOrder['destination'])) {
    throw new Error('invalid_demo_destination');
  }
  if (typeof raw.driverAlias !== 'string' || !DEMO_DRIVERS.some(driver => driver.id === raw.driverAlias)) {
    throw new Error('invalid_demo_driver');
  }
  if (!Number.isSafeInteger(raw.loadCount) || Number(raw.loadCount) < 1 || Number(raw.loadCount) > 3) {
    throw new Error('invalid_demo_load_count');
  }
  return {
    pickup: raw.pickup as VisitorOrder['pickup'],
    destination: raw.destination as VisitorOrder['destination'],
    driverAlias: raw.driverAlias as VisitorOrder['driverAlias'],
    loadCount: raw.loadCount as number,
  };
}
