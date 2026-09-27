/**
 * Active Jobs expanded-driver-group restore/prune — pure, node-testable.
 *
 * Live defect: an expanded driver group returned collapsed after a hard refresh.
 * Root sequence: auth/company resolves and the stored canonical group id is
 * restored, but Active Jobs data has not loaded yet, so the live group set is
 * momentarily empty. Pruning the restored set against that empty live set (then
 * persisting the empty result) drops the id before the canonical group ever
 * appears — the group renders collapsed and the saved state is gone.
 *
 * Rule enforced here:
 *   - While the dataset is NOT ready (drivers/dispatches still loading, canonical
 *     group keys not yet available), NEVER prune or overwrite the stored ids.
 *   - Only AFTER a completed, non-loading dataset, prune ids whose canonical
 *     group genuinely no longer exists.
 *   - Never persist an empty/default set over a saved set during hydration.
 *
 * Keys are canonical `dispatchDriverGroupKey` values (canonical driverId), never a
 * display name, login name, array index, or transient fallback key.
 */

export interface ExpandedPruneResult {
  next: string[];
  /** True only when `ready` AND the pruned result differs — the sole persist trigger. */
  changed: boolean;
}

/**
 * @param stored        the restored expanded canonical group ids
 * @param liveGroupKeys the canonical group keys currently present (dispatchDriverGroupKey)
 * @param ready         true only once auth/company are resolved AND the first real
 *                      Active Jobs dataset has loaded AND canonical group keys exist
 */
export function pruneExpandedGroups(
  stored: readonly string[] | null | undefined,
  liveGroupKeys: Iterable<string>,
  ready: boolean,
): ExpandedPruneResult {
  const cur = Array.isArray(stored) ? stored.filter((s) => typeof s === 'string' && s.length > 0) : [];
  // Not ready: hold the stored set verbatim. No prune, no overwrite, no persist —
  // the live set is not authoritative yet.
  if (!ready) return { next: cur, changed: false };
  const live = liveGroupKeys instanceof Set ? liveGroupKeys : new Set(liveGroupKeys);
  const next = cur.filter((id) => live.has(id));
  const changed = next.length !== cur.length;
  return { next, changed };
}

/**
 * Should this canonical group render expanded? True when the stored set contains
 * the group's canonical key. (The set is only pruned once ready, so during
 * hydration a not-yet-rendered group's id is preserved and re-expands on arrival.)
 */
export function isGroupExpanded(expanded: Iterable<string>, canonicalGroupKey: string): boolean {
  const set = expanded instanceof Set ? expanded : new Set(expanded);
  return set.has(canonicalGroupKey);
}
