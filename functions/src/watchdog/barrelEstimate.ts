/** Diagnostic only: estimates never replace written/default barrels or feed AFR. */
export function barrelEstimate(input: { top: number | null; bottom: number | null; bank: number; rateMinutesPerFoot: number; isDown: boolean; rateMeasuredAt: string; measuredAt: string }) {
  const { top, bottom, bank, rateMinutesPerFoot: rate } = input;
  if (typeof top !== 'number' || typeof bottom !== 'number' || !Number.isFinite(top) || !Number.isFinite(bottom) || bottom < 0 || top <= bottom || !Number.isFinite(bank) || bank <= 0 || bank > 1000) return null;
  const observedDropBbls = (top - bottom) * bank;
  if (observedDropBbls > 1000) return null;
  const baselineAt = Date.parse(input.rateMeasuredAt), measuredAt = Date.parse(input.measuredAt);
  const usableRate = !input.isDown && Number.isFinite(rate) && rate > 0 && Number.isFinite(baselineAt) && Number.isFinite(measuredAt) && baselineAt < measuredAt && measuredAt - baselineAt <= 86400000;
  // Loading duration is not in the post. Use the user-supplied typical 20 minutes, with 10–30 minute sensitivity;
  // do not present an invented duration or driver bottom as a measured quantity.
  const productionPerMinute = usableRate ? bank / rate : 0;
  return { mode: 'comparison_only', observedDropBbls: Math.round(observedDropBbls * 10) / 10,
    estimatedBbls: usableRate ? Math.round(observedDropBbls + 20 * productionPerMinute) : null,
    lowBbls: Math.round(observedDropBbls + 10 * productionPerMinute), highBbls: usableRate ? Math.round(observedDropBbls + 30 * productionPerMinute) : null,
    loadingMinutes: { assumed: 20, min: 10, max: 30 }, rateMinutesPerFoot: usableRate ? rate : null,
    baselineAt: usableRate ? input.rateMeasuredAt : null,
    caveat: 'Reported bottom and loading duration are unverified; estimate does not change barrels or AFR.' };
}
