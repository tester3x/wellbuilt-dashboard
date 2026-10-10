/** Mirror the opener's loaded CSS into an about:blank portal window. */
export function copyStyles(src: Document, dest: Document): () => void {
  const sync = () => {
    dest.head.querySelectorAll('[data-detached-style]').forEach(node => node.remove());
    // Keep source order so Tailwind layers and later overrides retain priority.
    src.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => {
      const sheet = (node as HTMLStyleElement | HTMLLinkElement).sheet;
      if (sheet) {
        try {
          // Use rules already loaded in the opener. A long-lived dashboard tab
          // can still render after a release removes its old hashed CSS asset,
          // but a fresh link in about:blank would request that now-missing URL.
          const rules = Array.from(sheet.cssRules, rule => rule.cssText).join('\n');
          const style = dest.createElement('style');
          style.textContent = rules;
          style.setAttribute('data-detached-style', '1');
          dest.head.appendChild(style);
          return;
        } catch { /* Cross-origin sheet: fall back to its live URL below. */ }
      }
      const clone = node.cloneNode(true) as Element;
      if (clone instanceof HTMLLinkElement) clone.href = (node as HTMLLinkElement).href;
      clone.setAttribute('data-detached-style', '1');
      dest.head.appendChild(clone);
    });
    dest.documentElement.className = src.documentElement.className;
    dest.body.className = src.body.className;
  };
  sync();
  // Keep late-injected styles (dev/HMR) and theme changes in sync.
  const headObserver = new MutationObserver(sync);
  headObserver.observe(src.head, { childList: true, subtree: true, characterData: true });
  const themeObserver = new MutationObserver(sync);
  themeObserver.observe(src.documentElement, { attributes: true, attributeFilter: ['class'] });
  themeObserver.observe(src.body, { attributes: true, attributeFilter: ['class'] });
  return () => { headObserver.disconnect(); themeObserver.disconnect(); };
}
