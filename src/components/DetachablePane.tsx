'use client';

/**
 * DetachablePane — Checkpoint 3.
 *
 * Renders its children in place while docked; when detached, opens a same-origin
 * child browser window and PORTALS the same React subtree into it. Because the
 * subtree stays part of the parent React tree, all state and handlers are shared
 * — selecting a well in a popped-out Well Queue updates the docked Job Builder
 * automatically, with NO customer data ever placed in a URL or a cross-window
 * message (the window is opened at about:blank).
 *
 * Guarantees / guards:
 *  - window.open('') → same-origin, blank URL (no data leakage via query string).
 *  - Popup blocked → falls back to docked (onDock) instead of losing the pane.
 *  - Parent stylesheets are copied into the child so the portaled UI is styled;
 *    a MutationObserver keeps late-injected styles (dev/HMR) in sync.
 *  - Closing the child window (or unmounting the parent) reattaches cleanly.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

function copyStyles(src: Document, dest: Document): () => void {
  const clone = (node: Element) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'style') {
      const s = dest.createElement('style');
      s.textContent = node.textContent;
      s.setAttribute('data-detached-style', '1');
      dest.head.appendChild(s);
    } else if (tag === 'link' && (node as HTMLLinkElement).rel === 'stylesheet') {
      const l = dest.createElement('link');
      l.rel = 'stylesheet';
      l.href = (node as HTMLLinkElement).href;
      l.setAttribute('data-detached-style', '1');
      dest.head.appendChild(l);
    }
  };
  src.querySelectorAll('style, link[rel="stylesheet"]').forEach(clone);
  // Inherit the app theme (Tailwind dark tokens hang off <html>/<body>).
  dest.documentElement.className = src.documentElement.className;
  dest.body.className = src.body.className;
  // Keep late-injected styles (HMR / dynamic) mirrored.
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) clone(n as Element);
      });
    }
  });
  obs.observe(src.head, { childList: true });
  return () => obs.disconnect();
}

export function DetachablePane({
  detached,
  onDock,
  title,
  mountClassName,
  placeholder,
  children,
}: {
  detached: boolean;
  onDock: () => void;
  title: string;
  /** className applied to the mount node inside the child window. */
  mountClassName?: string;
  /** rendered in the docked slot while detached (e.g. a Reattach card). */
  placeholder?: ReactNode;
  children: ReactNode;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!detached) return;
    // Same-origin, blank URL — no customer data in the URL.
    const child = window.open('', `wb_${title.replace(/\W+/g, '_')}`, 'width=560,height=920');
    if (!child) {
      // Popup blocked → do not silently lose the pane; stay docked.
      onDock();
      return;
    }
    child.document.title = title;
    child.document.body.style.margin = '0';
    const stopCopy = copyStyles(window.document, child.document);
    const mount = child.document.createElement('div');
    if (mountClassName) mount.className = mountClassName;
    child.document.body.appendChild(mount);
    setContainer(mount);

    const reattach = () => onDock();
    child.addEventListener('beforeunload', reattach);

    return () => {
      child.removeEventListener('beforeunload', reattach);
      stopCopy();
      setContainer(null);
      try { child.close(); } catch { /* already closed */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detached]);

  if (!detached) return <>{children}</>;
  return (
    <>
      {placeholder}
      {container ? createPortal(children, container) : null}
    </>
  );
}
