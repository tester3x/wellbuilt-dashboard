'use client';

import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { usePathname } from 'next/navigation';
import { getFirebaseFunctions } from '@/lib/firebase';

type PhoneFrame = { available: false } | { available: true; url: string; capturedAt: number };

/** The pixels come from a dedicated Android device running WB T. Viewers cannot tap it. */
export function DemoPhoneOverlay() {
  const pathname = usePathname();
  const isSuitePhonePage = pathname.startsWith('/payroll');
  const [frame, setFrame] = useState<PhoneFrame>({ available: false });
  const [checked, setChecked] = useState(false);
  const [expanded, setExpanded] = useState(true);

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
    <aside aria-label="Live WellBuilt demo phone" className="fixed bottom-2 right-2 z-[85] w-[180px] overflow-hidden rounded-[22px] border-2 border-cyan-500 bg-black shadow-2xl shadow-cyan-950/60 md:bottom-4 md:right-4 md:w-[248px]">
      <button type="button" onClick={() => setExpanded(value => !value)}
        className="flex w-full items-center justify-between bg-slate-900 px-3 py-2 text-left text-xs font-semibold text-cyan-100">
        <span>{isSuitePhonePage ? 'WB Suite' : 'WB Tickets'} · demo phone</span><span aria-hidden="true">{expanded ? '▾' : '▴'}</span>
      </button>
      {expanded && (
        <div className="relative aspect-[9/19.5] bg-black">
          {!isSuitePhonePage && frame.available ? (
            <img src={frame.url} alt="Live screen of the demo driver’s WB Tickets Android app"
              className="h-full w-full select-none object-contain" draggable={false} />
          ) : (
            <div className="flex h-full items-center justify-center px-5 text-center text-sm text-slate-400">
              {isSuitePhonePage
                ? 'The WB Suite phone feed is not connected yet.'
                : checked
                  ? 'The demo WB Tickets emulator is offline.'
                  : 'Connecting to the demo driver’s WB Tickets app…'}
            </div>
          )}
          <div className="pointer-events-auto absolute inset-0" aria-hidden="true" />
        </div>
      )}
    </aside>
  );
}
