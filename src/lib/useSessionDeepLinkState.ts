'use client';

/**
 * Session-scoped presentation state hook (RN/React glue over deepLinkStateCore).
 *
 * Persists ephemeral screen state (expanded groups, scroll, sort, pagination,
 * selection) to sessionStorage under a key scoped to uid + companyId + pathname, so
 * a normal/hard/popout refresh restores it — and state never leaks across companies
 * or users (different scope ⇒ different key ⇒ miss ⇒ default).
 *
 * SSR/static-export safe: every storage access is guarded and wrapped in try/catch,
 * so a private window, disabled storage, or the server render simply yields defaults.
 * Reads once the scope is ready; nothing is persisted for a non-restorable slot.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildDeepLinkStateKey,
  isRestorableSlot,
  parseState,
  scopeReady,
  serializeState,
  type DeepLinkScope,
} from './deepLinkStateCore';

function readSession(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(key, value);
  } catch {
    /* private window / quota / disabled — presentation state is best-effort */
  }
}

/**
 * `[value, setValue, restored]`. `restored` is true once a persisted value has been
 * read back for the current scope (useful to defer scroll restoration until data +
 * state are both ready). Persistence begins only after the scope is ready and only
 * for restorable slots.
 */
export function useSessionDeepLinkState<T>(
  scope: DeepLinkScope,
  slot: string,
  fallback: T,
): [T, (next: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [restored, setRestored] = useState(false);
  const keyRef = useRef<string | null>(null);

  const ready = scopeReady(scope) && isRestorableSlot(slot);
  const key = ready ? buildDeepLinkStateKey(scope, slot) : null;
  keyRef.current = key;

  // Restore whenever the scoped key changes (login, company switch, route change).
  useEffect(() => {
    if (!key) {
      setRestored(false);
      return;
    }
    const parsed = parseState<T>(readSession(key), scope, slot);
    if (parsed != null) setValue(parsed);
    else setValue(fallback);
    setRestored(true);
    // fallback intentionally excluded — a new default identity shouldn't re-run restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        const k = keyRef.current;
        if (k) writeSession(k, serializeState(scope, slot, resolved, Date.now()));
        return resolved;
      });
    },
    // scope/slot captured via keyRef + closure; stable enough for callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slot],
  );

  return [value, set, restored];
}
