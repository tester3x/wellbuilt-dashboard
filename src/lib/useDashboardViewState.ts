'use client';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { returnKey } from './dashboardReturnState';
/** Small presentation selections only. Never store records, drafts or write actions. */
export function useDashboardViewState<T extends string | number>(slot: string, fallback: T, allowed?: readonly T[]): [T, (value: SetStateAction<T>) => void] {
  const { user, operatingCompanyId, authResolved } = useAuth();
  const path = usePathname();
  const key = authResolved && user ? returnKey(user.uid, operatingCompanyId, `${path}:${slot}`) : null;
  const read = (): T => {
    if (key) try { const parsed = JSON.parse(sessionStorage.getItem(key) || 'null'); if (typeof parsed === typeof fallback && (typeof parsed !== 'number' || Number.isFinite(parsed)) && (!allowed || allowed.includes(parsed))) return parsed; } catch { /* defaults */ }
    return fallback;
  };
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({ key, value: read() }));
  const current = useRef(key); current.current = key;
  useEffect(() => {
    setState({ key, value: read() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback((next: SetStateAction<T>) => {
    const expected = key;
    setState(previous => {
      if (expected !== current.current) return previous;
      const before = previous.key === expected ? previous.value : fallback;
      const value = typeof next === 'function' ? (next as (old: T) => T)(before) : next;
      if (expected) try { sessionStorage.setItem(expected, JSON.stringify(value)); } catch { /* presentation only */ }
      return { key: expected, value };
    });
  }, [key, fallback]);
  return [state.key === key ? state.value : read(), set];
}
