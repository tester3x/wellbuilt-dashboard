export interface EditAfrSample {
  dateTimeUTC: string;
  flowRateDays: number;
  wellDown?: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Keep a single bad or shut-in interval from changing the published AFR on edit. */
export function calculateEditedAfr(samples: EditAfrSample[]): number {
  const recent = samples
    .filter((sample) => !sample.wellDown && Number.isFinite(sample.flowRateDays)
      && sample.flowRateDays > 0 && sample.flowRateDays < 365
      && Number.isFinite(Date.parse(sample.dateTimeUTC)))
    .sort((a, b) => Date.parse(a.dateTimeUTC) - Date.parse(b.dateTimeUTC))
    .slice(-15);
  if (recent.length === 0) return 0;

  const baseline = median(recent.map((sample) => sample.flowRateDays));
  const normal = recent.filter((sample) => {
    const ratio = Math.max(sample.flowRateDays / baseline, baseline / sample.flowRateDays);
    return ratio < 2;
  });
  // Preserve a real regime change when most recent samples form a new cluster.
  const usable = normal.length >= 3 ? normal : recent;
  const latest = usable.slice(-5);
  return latest.reduce((sum, sample) => sum + sample.flowRateDays, 0) / latest.length;
}
