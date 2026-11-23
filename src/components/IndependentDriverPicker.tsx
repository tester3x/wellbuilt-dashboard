'use client';

import type { ExternalDriver } from '@/lib/externalAssignmentDelivery';
import type { IndependentJob, LinkedWellBuiltDriver } from '@/lib/independentDispatchJobs';
import type { IndependentDriverProfile } from '@/lib/independentDriverProfiles';
import { driverAvailability } from '@/lib/independentDriverAvailability';

export type SelectedDriverShifts = Record<string, '' | 'day' | 'night'>;

export function IndependentDriverPicker({ job, jobs, outside, linked, profiles, now, selected, onChange, disabled }: {
  job: IndependentJob; jobs: IndependentJob[]; outside: ExternalDriver[]; linked: LinkedWellBuiltDriver[];
  profiles: IndependentDriverProfile[]; now: number; selected: SelectedDriverShifts;
  onChange: (next: SelectedDriverShifts) => void; disabled: boolean;
}) {
  const assigned = new Set(Array.isArray(job.drivers) ? job.drivers.map(driver => driver.key)
    : job.externalDriverId ? [`outside:${job.externalDriverId}`] : job.wbDriverId ? [`wellbuilt:${job.wbDriverId}`] : []);
  const defaultShift = job.shift === 'day' || job.shift === 'night' ? job.shift : '';
  const groups = [
    { label: 'Outside drivers', rows: outside.map(driver => ({ key: `outside:${driver.externalDriverId}`, name: driver.displayName,
      active: driver.active, preference: driver.shiftPreference || 'unset' })) },
    { label: 'Linked WellBuilt drivers', rows: linked.map(driver => ({ key: `wellbuilt:${driver.driverId}`, name: driver.displayName,
      active: driver.active, preference: profiles.find(profile => profile.driverKey === `wellbuilt:${driver.driverId}`)?.shiftPreference || 'unset' })) },
  ];
  const count = Object.keys(selected).length;
  return <details className="min-w-56 rounded border border-gray-600 bg-gray-900 text-sm text-white">
    <summary className="cursor-pointer px-3 py-2 text-cyan-200">Choose drivers{count ? ` (${count} selected)` : ''}</summary>
    <div className="max-h-64 overflow-auto border-t border-gray-700 p-2">
      {groups.map(group => <div key={group.label} className="mb-2 last:mb-0">
        <p className="mb-1 text-xs font-semibold text-gray-400">{group.label}</p>
        {group.rows.map(driver => {
          const current = assigned.has(driver.key);
          const availability = driverAvailability(job, driver.key, jobs, driver.active, now);
          const unavailable = current || !availability.available;
          const checked = Object.prototype.hasOwnProperty.call(selected, driver.key);
          return <div key={driver.key} className="flex flex-wrap items-center gap-2 rounded px-2 py-1 hover:bg-gray-800">
            <label className={`flex min-w-0 flex-1 items-center gap-2 ${unavailable ? 'text-gray-500' : 'text-white'}`}>
              <input type="checkbox" aria-label={`Choose ${driver.name} for ${job.title}`} checked={checked} disabled={disabled || (unavailable && !checked)}
                onChange={event => {
                  const next = { ...selected };
                  if (event.target.checked) next[driver.key] = defaultShift;
                  else delete next[driver.key];
                  onChange(next);
                }} />
              <span className="truncate">{driver.name}</span>
            </label>
            <span className="text-xs text-gray-400">{current ? 'On this job' : driver.preference !== 'unset' ? `Prefers ${driver.preference} · ${availability.label}` : availability.label}</span>
            {checked && <select aria-label={`Shift for ${driver.name} on ${job.title}`} value={selected[driver.key]} disabled={disabled}
              onChange={event => onChange({ ...selected, [driver.key]: event.target.value as SelectedDriverShifts[string] })}
              className="rounded border border-gray-600 bg-gray-950 px-2 py-1 text-xs text-white">
              <option value="">Shift unset</option><option value="day">Day</option><option value="night">Night</option>
            </select>}
          </div>;
        })}
      </div>)}
    </div>
  </details>;
}
