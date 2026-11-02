/** Total bank calibration. Stored rates include all active tanks. Never guess 20 bbl/ft. */
export function resolveTankBblPerFoot(config: Record<string, unknown>): number {
  const positive = (value: unknown): number | null => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const stored = positive(config.bblPerFoot);
  if (stored !== null) return stored;
  const capacity = positive(config.tankCapacity);
  const height = positive(config.tankHeight);
  // An explicitly configured active count must be valid; do not silently use all tanks.
  const count = config.activeTanks != null
    ? positive(config.activeTanks)
    : positive(config.tanks) ?? positive(config.numTanks);
  if (capacity !== null && height !== null && count !== null) {
    const rate = capacity / height * count;
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  throw new Error('bbl_per_foot_unavailable');
}
