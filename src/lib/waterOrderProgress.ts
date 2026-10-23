import {readyWaterTrips, type WaterPlan, type WaterTrip} from './waterOrderPlanner.ts';

export type WaterTripStatus = 'Delivered' | 'Completed' | 'Cancelled' | 'Sent' | 'Scheduled' | 'Waiting' | 'Ready' | 'Expired';
const terminal = new Set(['completed', 'cancelled', 'dismissed', 'declined']);

/** One release decision for the preview, ready count and governed dispatch loop. */
export function releasableWaterTrips(plan: WaterPlan, sent: readonly string[], now: number,
  closed: Record<string, number>, linked: Record<string, string>) {
  return readyWaterTrips(plan, sent, now).filter(t => plan.trips.every(p =>
    p.driverKey !== t.driverKey || Date.parse(p.startAt) >= Date.parse(t.startAt) ||
    closed[p.id] !== undefined || terminal.has(linked[p.id])));
}

export function waterTripStatus(trip: WaterTrip, plan: WaterPlan, sent: readonly string[], now: number,
  closed: Record<string, number>, linked: Record<string, string>, ready: ReadonlySet<string>): WaterTripStatus {
  if (closed[trip.id] !== undefined) return 'Delivered';
  if (['cancelled', 'dismissed', 'declined'].includes(linked[trip.id])) return 'Cancelled';
  if (linked[trip.id] === 'completed') return 'Completed';
  if (sent.includes(trip.id) || linked[trip.id]) return 'Sent';
  if (now + trip.cycleMinutes * 60000 > Date.parse(plan.deadline)) return 'Expired';
  if (Date.parse(trip.startAt) > now) return 'Scheduled';
  return ready.has(trip.id) ? 'Ready' : 'Waiting';
}
