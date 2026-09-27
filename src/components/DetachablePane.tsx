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
 *  - EXACTLY ONE live mount: the child body is cleared before the single mount node
 *    is appended, and the window is reused through a ref, so a re-run can never
 *    strand a second, orphaned copy of the subtree (the cause of the duplicated
 *    Active-Jobs group + dead Reattach button seen in the popup).
 *  - The inner pane body is the SOLE vertical scroll owner: the child document and
 *    body are pinned to the window height with overflow hidden, so the document
 *    never grows "phantom" empty height that scrolls independently of the cards.
 *  - The window opens centered and clamped to the available screen at the requested
 *    size (Active Jobs uses ~1100×800), but nothing about scrolling/reattach depends
 *    on that size — it keeps working after the user makes the window narrow or short.
 *  - Parent stylesheets are copied into the child so the portaled UI is styled;
 *    a MutationObserver keeps late-injected styles (dev/HMR) in sync.
 *  - Closing the child window (X) or unmounting the parent reattaches cleanly and
 *    returns focus to the opener.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
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

/** Center a w×h window on the available screen, clamped so it never exceeds it. */
function centeredFeatures(reqW: number, reqH: number): string {
  const scr = typeof window !== 'undefined' ? window.screen : undefined;
  const availW = scr?.availWidth ?? reqW;
  const availH = scr?.availHeight ?? reqH;
  const w = Math.max(360, Math.min(reqW, availW));
  const h = Math.max(320, Math.min(reqH, availH));
  const baseLeft = (scr as (Screen & { availLeft?: number }) | undefined)?.availLeft ?? 0;
  const baseTop = (scr as (Screen & { availTop?: number }) | undefined)?.availTop ?? 0;
  const left = Math.round(baseLeft + Math.max(0, (availW - w) / 2));
  const top = Math.round(baseTop + Math.max(0, (availH - h) / 2));
  return `popup=yes,width=${Math.round(w)},height=${Math.round(h)},left=${left},top=${top}`;
}

export function DetachablePane({
  detached,
  onDock,
  title,
  mountClassName,
  placeholder,
  width = 560,
  height = 920,
  children,
}: {
  detached: boolean;
  onDock: () => void;
  title: string;
  /** className applied to the mount node inside the child window. */
  mountClassName?: string;
  /** rendered in the docked slot while detached (e.g. a Reattach card). */
  placeholder?: ReactNode;
  /** requested popup size (clamped to the available screen, centered). */
  width?: number;
  height?: number;
  children: ReactNode;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const winRef = useRef<Window | null>(null);

  useEffect(() => {
    if (!detached) return;
    // Reuse an already-open window (defensive) rather than spawning a second one;
    // same-origin, blank URL — no customer data in the URL.
    let child: Window | null = winRef.current && !winRef.current.closed ? winRef.current : null;
    if (!child) child = window.open('', `wb_${title.replace(/\W+/g, '_')}`, centeredFeatures(width, height));
    if (!child) {
      // Popup blocked → do not silently lose the pane; stay docked.
      onDock();
      return;
    }
    winRef.current = child;
    child.document.title = title;

    // The inner pane body owns ALL vertical scroll. Pin the child document/body to
    // the window box and forbid document-level scroll, so dragging the scrollbar
    // moves the cards — never a phantom empty document height.
    const html = child.document.documentElement;
    html.style.height = '100%';
    html.style.overflow = 'hidden';
    child.document.body.style.margin = '0';
    child.document.body.style.height = '100%';
    child.document.body.style.overflow = 'hidden';

    // EXACTLY ONE mount: clear any prior content (a reused window, or a stale mount
    // left by a previous run) so the subtree is never rendered twice.
    child.document.body.replaceChildren();
    const stopCopy = copyStyles(window.document, child.document);
    const mount = child.document.createElement('div');
    mount.setAttribute('data-wb-detached-mount', '1');
    if (mountClassName) mount.className = mountClassName;
    child.document.body.appendChild(mount);
    setContainer(mount);

    // Close detection: `beforeunload`/`pagehide` on a popup are unreliable (they
    // do not fire on a programmatic close and are flaky on user close), which
    // would strand the pane in the popped-out placeholder forever. Poll
    // `child.closed` — the only cross-browser-reliable signal — and reattach.
    const reattach = () => onDock();
    child.addEventListener('pagehide', reattach); // best-effort, fast path
    const poll = window.setInterval(() => {
      if (!child || child.closed) onDock();
    }, 400);

    return () => {
      window.clearInterval(poll);
      try { child.removeEventListener('pagehide', reattach); } catch { /* cross-origin/closed */ }
      stopCopy();
      setContainer(null);
      const opener = child.opener as Window | null;
      winRef.current = null;
      try { child.close(); } catch { /* already closed */ }
      // Return focus to the main dashboard after reattach.
      try { opener?.focus?.(); } catch { /* ignore */ }
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
