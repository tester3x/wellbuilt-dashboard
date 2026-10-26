/** Keep arithmetic independent of whole-inch presentation strings. */
export function previousPullBottomInches(packet: unknown, displayFallback: number): number {
  const value = (packet as {tankAfterInches?: unknown} | null)?.tankAfterInches;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : displayFallback;
}
