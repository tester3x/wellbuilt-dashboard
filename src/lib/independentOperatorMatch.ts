import type { NdicOperator } from './firestoreWells';

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const commonAliases: Record<string, string> = { exmo: 'exxonmobil', exxon: 'exxonmobil' };

/** Resolve only an unambiguous catalog operator. Dispatch can choose another manually. */
export function matchIndependentOperator(names: string[], operators: NdicOperator[]): string {
  const candidates = names.map(name => normalize(name)).filter(Boolean);
  for (const candidate of candidates) {
    const target = commonAliases[candidate] || candidate;
    const exact = operators.filter(operator => normalize(operator.name) === target);
    if (exact.length === 1) return exact[0].name;
    const prefix = operators.filter(operator => normalize(operator.name).startsWith(target) && target.length >= 3);
    if (prefix.length === 1) return prefix[0].name;
    const root = target.replace(/(services|service|llc|inc|corporation|corp)$/, '');
    if (root.length >= 5 && root !== target) {
      const rootMatches = operators.filter(operator => normalize(operator.name).startsWith(root));
      if (rootMatches.length === 1) return rootMatches[0].name;
    }
  }
  return '';
}
