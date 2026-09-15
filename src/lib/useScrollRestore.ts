'use client';

/**
 * Session-scoped scroll-position restore for refresh/deep-link durability.
 *
 * Persists the scroll offset of a target container (an element matching
 * `elementSelector`, else the window) to sessionStorage keyed by uid+companyId+
 * pathname, and restores it AFTER the underlying data has laid out — it retries the
 * restore across animation frames for a bounded window until the target offset is
 * actually reachable (content tall enough), so it doesn't clamp to 0 before data loads.
 *
 * Never persists/restores across companies or users (scope-keyed). SSR/static-export
 * safe: every DOM/storage access is guarded.
 */

import { useEffect, useRef } from 'react';
import {
  buildDeepLinkStateKey,
  parseState,
  scopeReady,
  serializeState,
  type DeepLinkScope,
} from './deepLinkStateCore';

const SLOT = 'scroll';

function scroller(elementSelector?: string): { get: () => number; set: (y: number) => void; maxY: () => number } | null {
  if (typeof window === 'undefined') return null;
  const el = elementSelector ? (document.querySelector(elementSelector) as HTMLElement | null) : null;
  if (el) {
    return {
      get: () => el.scrollTop,
      set: (y) => { el.scrollTop = y; },
      maxY: () => Math.max(0, el.scrollHeight - el.clientHeight),
    };
  }
  return {
    get: () => window.scrollY || document.documentElement.scrollTop || 0,
    set: (y) => window.scrollTo(0, y),
    maxY: () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  };
}

function readRaw(key: string): string | null {
  try { return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage.getItem(key) : null; }
  catch { return null; }
}
function writeRaw(key: string, v: string): void {
  try { if (typeof window !== 'undefined' && window.sessionStorage) window.sessionStorage.setItem(key, v); }
  catch { /* best-effort */ }
}

export function useScrollRestore(scope: DeepLinkScope, opts?: { elementSelector?: string; ready?: boolean }): void {
  const ready = opts?.ready ?? true;
  const selector = opts?.elementSelector;
  const restoredRef = useRef(false);

  // Persist on scroll (throttled via rAF) once the scope is ready.
  useEffect(() => {
    if (!scopeReady(scope)) return;
    const s = scroller(selector);
    if (!s) return;
    const key = buildDeepLinkStateKey(scope, SLOT);
    const target = selector ? (document.querySelector(selector) as HTMLElement | null) : window;
    if (!target) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        writeRaw(key, serializeState(scope, SLOT, { y: s.get() }, Date.now()));
      });
    };
    (target as Window | HTMLElement).addEventListener('scroll', onScroll, { passive: true });
    return () => {
      (target as Window | HTMLElement).removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scope, selector]);

  // Restore once, after data has laid out (bounded rAF retry until offset reachable).
  useEffect(() => {
    if (restoredRef.current || !ready || !scopeReady(scope)) return;
    const s = scroller(selector);
    if (!s) return;
    const key = buildDeepLinkStateKey(scope, SLOT);
    const saved = parseState<{ y: number }>(readRaw(key), scope, SLOT);
    const wantY = saved && typeof saved.y === 'number' ? saved.y : 0;
    if (wantY <= 0) { restoredRef.current = true; return; }
    let tries = 0;
    let raf = 0;
    const attempt = () => {
      tries += 1;
      if (s.maxY() >= wantY - 2 || tries > 40) {
        s.set(Math.min(wantY, s.maxY()));
        restoredRef.current = true;
        return;
      }
      raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [scope, selector, ready]);
}
