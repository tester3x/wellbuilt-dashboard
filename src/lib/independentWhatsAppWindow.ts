let companionTab: Window | null = null;

/** Keep dispatch open while reusing one WhatsApp tab when the browser permits it. */
export function openIndependentWhatsApp(url: string): boolean {
  if (!url.startsWith('https://wa.me/')) return false;
  const tab = companionTab && !companionTab.closed
    ? companionTab
    : window.open('about:blank', 'wellbuilt-independent-whatsapp');
  if (!tab) return false;
  try { tab.opener = null; } catch { /* Some browsers restrict cross-origin windows. */ }
  tab.location.href = url;
  tab.focus();
  companionTab = tab;
  return true;
}
