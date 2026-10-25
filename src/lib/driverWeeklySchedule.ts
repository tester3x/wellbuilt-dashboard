export interface DriverWeeklySchedule {
  shiftPlan?: Record<string, 'day' | 'night' | 'off'>;
  usualShift?: 'day' | 'night';
  weeklyDaysOff?: number[];
}

/** The dated exception wins, including a day worked on a regular day off. */
export function plannedDriverShift(driver: DriverWeeklySchedule, date: string): 'day' | 'night' | 'off' | null {
  const dated = driver.shiftPlan?.[date];
  if (dated === 'day' || dated === 'night' || dated === 'off') return dated;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  if (driver.weeklyDaysOff?.includes(parsed.getUTCDay())) return 'off';
  return driver.usualShift === 'day' || driver.usualShift === 'night' ? driver.usualShift : null;
}

/** A regular or explicitly dated day off blocks pre-dispatch until the live shift opens. */
export function preDispatchBlocked(driver: DriverWeeklySchedule, date: string, liveShiftTitle: string, today = localToday()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  const dayOff = driver.weeklyDaysOff?.includes(parsed.getUTCDay()) === true || driver.shiftPlan?.[date] === 'off';
  return dayOff && (date !== today || liveShiftTitle !== 'On shift');
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
