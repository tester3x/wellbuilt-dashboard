import { getActiveTab } from './tabs';
export const returnKey = (uid: string, company: string | null, slot: string) => `wb:return:v1:${JSON.stringify([uid, company || '@platform', slot])}`;
export interface ReturnSnapshot { href: string; offsets: Record<string, { x: number; y: number }> }
export function validTabReturn(raw: unknown, tab: string): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  try { const url = new URL(raw, 'https://dashboard.invalid');
    if (url.origin !== 'https://dashboard.invalid' || getActiveTab(url.pathname) !== tab) return null;
    if ([...url.searchParams.keys()].some(key => /token|password|passcode|secret|authorization|^code$/i.test(key))) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}
export function rememberedTabHref(uid: string, company: string | null, tab: string, fallback: string): string {
  try { return validTabReturn(JSON.parse(sessionStorage.getItem(returnKey(uid, company, `tab:${tab}`)) || 'null'), tab) || fallback; }
  catch { return fallback; }
}
export function rememberTabHref(uid: string, company: string | null): void {
  if (typeof window === 'undefined') return;
  const tab = getActiveTab(window.location.pathname), href = window.location.pathname + window.location.search + window.location.hash;
  if (tab && validTabReturn(href, tab)) try { sessionStorage.setItem(returnKey(uid, company, `tab:${tab}`), JSON.stringify(href)); } catch { /* presentation only */ }
}
