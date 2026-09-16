/**
 * Pure helpers for the Projects builder's multi-well selection. Extracted so the
 * selection SEMANTICS are unit-testable: the selection is always an array, adding is
 * de-duplicated and order-preserving, and removing one well preserves every other.
 * This does NOT touch the project payload shape (still string[]) or dispatch
 * generation (the N×M well×driver fan-out remains inline in the builder).
 */

/** Append a well, preserving order; never adds a duplicate. */
export function addProjectWell(list: readonly string[], name: string): string[] {
  return list.includes(name) ? [...list] : [...list, name];
}

/** Remove exactly one well, preserving every other selected well and their order. */
export function removeProjectWell(list: readonly string[], name: string): string[] {
  return list.filter((n) => n !== name);
}
