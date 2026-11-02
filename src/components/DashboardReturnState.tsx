'use client';
import { useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { rememberTabHref, returnKey, type ReturnSnapshot } from '@/lib/dashboardReturnState';

export function DashboardReturnState() {
  const { user, operatingCompanyId, authResolved } = useAuth();
  const pathname = usePathname();
  useLayoutEffect(() => {
    if (!authResolved || !user || pathname === '/login' || pathname === '/live-demo' || pathname === '/join' || pathname.startsWith('/join/') || pathname === '/register' || pathname === '/welcome') return;
    const key = returnKey(user.uid, operatingCompanyId, `scroll:${pathname}`);
    let saved: ReturnSnapshot | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { /* defaults */ }
    // Explicit links to another filter/subpage retain their intended position.
    if (!saved || typeof saved !== 'object' || !saved.offsets || saved.href !== location.pathname + location.search + location.hash) saved = null;
    let restoring = !!saved, frame = 0, pendingSave = 0, stopped = false;
    const targets = () => [{ id: 'window', element: document.scrollingElement as HTMLElement },
      ...Array.from(document.querySelectorAll<HTMLElement>('[data-dashboard-scroll]')).map(element => ({ id: element.dataset.dashboardScroll!, element }))];
    const save = () => {
      if (restoring || stopped) return;
      rememberTabHref(user.uid, operatingCompanyId);
      const offsets = { ...saved?.offsets, ...Object.fromEntries(targets().filter(t => t.element && (t.id === 'window' || t.element.getClientRects().length)).map(t => [t.id, { x: t.element.scrollLeft, y: t.element.scrollTop }])) };
      saved = { href: location.pathname + location.search + location.hash, offsets };
      try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch { /* private browsing */ }
    };
    const onScroll = () => { if (!pendingSave && !restoring) pendingSave = requestAnimationFrame(() => { pendingSave = 0; save(); }); };
    const stopRestore = () => { restoring = false; if (frame) cancelAnimationFrame(frame); };
    const restore = () => {
      if (!restoring || stopped) return;
      for (const { id, element } of targets()) {
        const offset = saved?.offsets?.[id];
        if (!element || !offset || !Number.isFinite(offset.y) || !Number.isFinite(offset.x) || (id !== 'window' && !element.getClientRects().length)) continue;
        element.scrollTop = Math.min(Math.max(0, offset.y), Math.max(0, element.scrollHeight - element.clientHeight));
        element.scrollLeft = Math.min(Math.max(0, offset.x), Math.max(0, element.scrollWidth - element.clientWidth));
      }
    };
    // Retry as data/panels lay out, not just on the first short loading screen.
    const observer = new MutationObserver(() => { if (restoring && !frame) frame = requestAnimationFrame(() => { frame = 0; restore(); }); });
    observer.observe(document.body, { childList: true, subtree: true });
    let passes = 0;
    const initial = () => { frame = 0; restore(); if (++passes < 3 && restoring) frame = requestAnimationFrame(initial); };
    frame = requestAnimationFrame(initial);
    const timer = window.setTimeout(() => { restore(); stopRestore(); }, 15000);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('pagehide', save);
    document.addEventListener('click', save, true);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) document.addEventListener(event, stopRestore, { capture: true, passive: true });
    return () => {
      // Scroll events/click capture already saved the OLD page before React removed it.
      stopped = true; observer.disconnect(); clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame); if (pendingSave) cancelAnimationFrame(pendingSave);
      document.removeEventListener('scroll', onScroll, true); document.removeEventListener('click', save, true); window.removeEventListener('pagehide', save);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) document.removeEventListener(event, stopRestore, true);
    };
  }, [authResolved, user?.uid, operatingCompanyId, pathname]);
  return null;
}
