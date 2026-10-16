import { createHash } from 'crypto';

export interface DemoWellClock {
  realMinutesPerFoot: number;
  clockMultiplier: number;
  minimumTriggerInches: number;
  maximumTriggerInches: number;
  bottomInches: number;
  bblPerFoot: number;
  pullCapBbls: number;
  tankHeightInches: number;
}

/** A demo clock is opt-in on a demo-owned well. Real customer wells never use it. */
export function demoWellClock(config: Record<string, unknown>): DemoWellClock | null {
  if (config.companyId !== 'wellbuilt-demo' || config.isDemo !== true) return null;
  const realMinutesPerFoot = Number(config.demoRealMinutesPerFoot);
  const clockMultiplier = Number(config.demoClockMultiplier);
  const tankHeightInches = Number(config.tankHeight) * 12;
  const targetPercent = Number(config.demoTriggerTargetPercent);
  const variancePercent = Number(config.demoTriggerVariancePercent);
  const percentageRange = config.demoTriggerTargetPercent !== undefined
    && config.demoTriggerVariancePercent !== undefined;
  const minimumTriggerInches = percentageRange
    ? Math.round(tankHeightInches * (targetPercent - variancePercent) / 100)
    : Number(config.demoTriggerMinInches);
  const maximumTriggerInches = percentageRange
    ? Math.round(tankHeightInches * (targetPercent + variancePercent) / 100)
    : Number(config.demoTriggerMaxInches);
  const bottomInches = Number(config.bottomLevel) * 12;
  const bblPerFoot = Number(config.bblPerFoot);
  const tanks = Number(config.tanks ?? config.numTanks);
  const configuredPullCapBbls = Number(config.demoPullCapBbls);
  // A demo load never exceeds 120 BBL, even if an older config has a higher cap.
  const pullCapBbls = Math.min(configuredPullCapBbls, 120);
  if (![realMinutesPerFoot, clockMultiplier, minimumTriggerInches, maximumTriggerInches,
    bottomInches, bblPerFoot, tanks, configuredPullCapBbls, tankHeightInches].every(Number.isFinite)
    || realMinutesPerFoot < 1 || realMinutesPerFoot > 1440
    || clockMultiplier < 1 || clockMultiplier > 120
    || bottomInches < 0 || tanks !== 1 || bblPerFoot !== 20 || configuredPullCapBbls <= 0
    || (percentageRange && (targetPercent <= 0 || targetPercent > 100
      || variancePercent < 0 || variancePercent >= targetPercent
      || targetPercent + variancePercent > 100))
    || minimumTriggerInches <= bottomInches || maximumTriggerInches < minimumTriggerInches
    || maximumTriggerInches > tankHeightInches) return null;
  return { realMinutesPerFoot, clockMultiplier, minimumTriggerInches, maximumTriggerInches,
    bottomInches, bblPerFoot, pullCapBbls, tankHeightInches };
}

/** Stable for one pull, different for the next; never changes on a page refresh. */
export function demoTriggerInches(clock: DemoWellClock, lastPacketId: string): number {
  const hash = createHash('sha256').update(lastPacketId || 'new-well').digest();
  const span = clock.maximumTriggerInches - clock.minimumTriggerInches + 1;
  return clock.minimumTriggerInches + (hash.readUInt32BE(0) % span);
}

export function demoProjectedInches(clock: DemoWellClock, bottomInches: number,
  pullTimeMs: number, nowMs: number, triggerInches: number): number {
  const elapsedMinutes = Math.max(0, (nowMs - pullTimeMs) / 60_000);
  // Public demo time pauses at the next dispatch threshold when nobody is
  // watching. Resume from the real ticket's measured bottom after each pull.
  return Math.min(clock.tankHeightInches, triggerInches,
    bottomInches + elapsedMinutes * clock.clockMultiplier * 12 / clock.realMinutesPerFoot);
}

export function demoReadyAtMs(clock: DemoWellClock, bottomInches: number,
  pullTimeMs: number, triggerInches: number): number {
  const recoveryInches = Math.max(0, triggerInches - bottomInches);
  return pullTimeMs + recoveryInches / 12 * clock.realMinutesPerFoot / clock.clockMultiplier * 60_000;
}

/** Round measurement to an inch, volume down to 5 BBL; never cross allowed bottom. */
export function demoPullPlan(clock: DemoWellClock, estimatedInches: number,
  triggerInches: number): { ready: boolean; topInches: number; bbls: number; bottomInches: number } {
  const topInches = Math.min(clock.tankHeightInches, Math.floor(estimatedInches));
  const availableBbls = Math.max(0, (topInches - clock.bottomInches) / 12 * clock.bblPerFoot);
  const bbls = Math.min(clock.pullCapBbls, Math.floor(availableBbls / 5) * 5);
  const bottomInches = topInches - bbls / clock.bblPerFoot * 12;
  return { ready: topInches >= triggerInches && bbls > 0,
    topInches, bbls, bottomInches };
}
