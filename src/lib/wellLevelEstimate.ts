/** Shared post-pull flow estimate used by live RTDB merge and catalog fallback. */

export function parseFeetInches(str: string): number {
  if (!str) return 0;
  const match = String(str).match(/(\d+)'(\d+)"/);
  if (match) return parseInt(match[1], 10) * 12 + parseInt(match[2], 10);
  return 0;
}

export function inchesToFeetInches(totalInches: number): string {
  const feet = Math.floor(totalInches / 12);
  const inches = Math.floor(totalInches % 12);
  return `${feet}'${inches}"`;
}

/**
 * Packet pull math: post-pull inches = top inches − (BBL / (bblPerFootPerTank * tanks)) * 12.
 * Used to prove WB-M/cloud packet records are not double-subtracting volume.
 */
export function postPullInchesFromTop(input: {
  topLevel: string;
  bblsPulled: number;
  tanks: number;
  bblPerFootPerTank: number;
}): number {
  const top = parseFeetInches(input.topLevel);
  const tanks = input.tanks > 0 ? input.tanks : 1;
  const feetRemoved = input.bblsPulled / (input.bblPerFootPerTank * tanks);
  return top - feetRemoved * 12;
}

/**
 * avgFlowRateMinutes is minutes per foot of rise (Cloud Function AFR).
 * Estimate current inches = post-pull bottom + elapsed / (AFR/12).
 */
export function estimateInchesFromPostPull(input: {
  postPullLevel: string;
  lastPullUtc: string;
  avgFlowRateMinutes: number;
  nowMs?: number;
}): number | null {
  if (!input.lastPullUtc || input.avgFlowRateMinutes <= 0) return null;
  const bottom = parseFeetInches(input.postPullLevel);
  if (bottom <= 0) return null;
  const last = new Date(input.lastPullUtc).getTime();
  if (isNaN(last) || last <= 0) return null;
  const minutesElapsed = ((input.nowMs ?? Date.now()) - last) / (1000 * 60);
  if (minutesElapsed < 0) return bottom;
  const minutesPerInch = input.avgFlowRateMinutes / 12;
  return bottom + minutesElapsed / minutesPerInch;
}

export function calcTankAtInches(
  tanks: number,
  pullBbls: number,
  bottomInches: number,
  bblPerFootPerTank: number = 20,
): number {
  const n = tanks > 0 ? tanks : 1;
  const bblsPerTank = pullBbls / n;
  return ((bblsPerTank / bblPerFootPerTank) * 12) + bottomInches;
}

export function calcTimeTillPull(
  currentInches: number,
  targetInches: number,
  flowRateMinutes: number,
): string {
  if (flowRateMinutes <= 0) return 'Unknown';
  const inchesNeeded = targetInches - currentInches;
  if (inchesNeeded <= 0) return 'Ready';
  const minutesPerInch = flowRateMinutes / 12;
  const totalMinutes = inchesNeeded * minutesPerInch;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = Math.floor(totalMinutes % 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  return `${hours}h ${mins}m`;
}
