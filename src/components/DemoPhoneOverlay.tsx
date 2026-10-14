'use client';

import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { usePathname } from 'next/navigation';
import { getFirebaseFunctions } from '@/lib/firebase';

type PhoneFrame = { available: false } | { available: true; url: string; capturedAt: number; live: boolean };

/** The pixels come from a dedicated Android device running WB T. Viewers cannot tap it. */
export function DemoPhoneOverlay() {
  const pathname = usePathname();
  const isSuitePhonePage = pathname.startsWith('/payroll');
  const [frame, setFrame] = useState<PhoneFrame>({ available: false });
  const [checked, setChecked] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [large, setLarge] = useState(false);

  useEffect(() => {
    if (isSuitePhonePage) return;
    let alive = true;
    let busy = false;
    const read = httpsCallable<undefined, PhoneFrame>(getFirebaseFunctions(), 'liveDemoPhoneFrame');
    const poll = async () => {
      if (!alive || busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const result = await read();
        if (alive) { setFrame(result.data); setChecked(true); }
      } catch {
        if (alive) { setFrame({ available: false }); setChecked(true); }
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [isSuitePhonePage]);

  return (
    <aside aria-label="Live WellBuilt demo phone" className={`fixed bottom-2 right-2 z-[85] w-[min(86vw,320px)] overflow-hidden rounded-[22px] border-2 border-cyan-500 bg-black shadow-2xl shadow-cyan-950/60 md:bottom-4 md:right-4 ${large ? 'md:w-[min(42vw,440px)]' : 'md:w-[320px]'}`}>
      <div className="flex w-full items-center justify-between bg-slate-900 px-3 py-2 text-xs font-semibold text-cyan-100">
        <button type="button" onClick={() => setExpanded(value => !value)} className="text-left">
          {isSuitePhonePage ? 'WB Suite' : 'WB Tickets'} · demo phone <span aria-hidden="true">{expanded ? '▾' : '▴'}</span>
        </button>
        <button type="button" onClick={() => { setLarge(value => !value); setExpanded(true); }} className="rounded border border-cyan-600 px-2 py-1 hover:bg-cyan-950" aria-label={large ? 'Use normal phone size' : 'Enlarge demo phone'}>
          {large ? 'Normal' : 'Enlarge'}
        </button>
      </div>
      {expanded && (
        <div className="relative aspect-[9/19.5] max-h-[calc(100vh-6rem)] bg-black">
          {!isSuitePhonePage && frame.available ? (
            <>
              <img src={frame.url} alt={frame.live ? 'Live demo driver WB Tickets screen' : 'Last verified demo driver WB Tickets screen'}
                className="h-full w-full select-none object-contain" draggable={false} />
              {!frame.live && (
                <div className="absolute bottom-3 left-2 right-2 rounded-md border border-amber-400/60 bg-slate-950/95 px-2 py-1.5 text-center text-[11px] font-semibold leading-tight text-amber-200">
                  Paused between jobs · Last verified screen
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-5 text-center text-sm text-slate-400">
              {isSuitePhonePage
                ? 'The WB Suite phone feed is not connected yet.'
                : checked
                  ? 'No verified demo phone screen is available yet.'
                  : 'Connecting to the demo driver’s WB Tickets app…'}
            </div>
          )}
          <div className="pointer-events-auto absolute inset-0" aria-hidden="true" />
        </div>
      )}
    </aside>
  );
}
