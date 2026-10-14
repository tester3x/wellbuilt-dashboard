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
    <aside aria-label="Live WellBuilt demo phone" className={`fixed bottom-3 right-3 z-[85] w-[min(90vw,370px)] rounded-[38px] border-[10px] border-[#17191d] bg-[#090a0c] p-[4px] shadow-[inset_0_0_0_2px_#373a40,0_18px_42px_#000b,4px_4px_0_#08090a] ring-2 ring-[#34363b] md:bottom-5 md:right-5 ${large ? 'md:w-[min(45vw,480px)]' : 'md:w-[370px]'}`}>
      <span aria-hidden="true" className="absolute -left-[13px] top-[19%] h-16 w-[5px] rounded-l bg-[#34363b] shadow-[inset_1px_0_#63676b]" />
      <span aria-hidden="true" className="absolute -left-[13px] top-[31%] h-10 w-[5px] rounded-l bg-[#34363b] shadow-[inset_1px_0_#63676b]" />
      <span aria-hidden="true" className="absolute -right-[13px] top-[25%] h-20 w-[5px] rounded-r bg-[#34363b] shadow-[inset_-1px_0_#63676b]" />
      <div className="overflow-hidden rounded-[27px] border-[3px] border-[#3a3d42] bg-black shadow-[inset_0_0_0_2px_#0c0d0f]">
      <div className="flex w-full items-center justify-between bg-[#121417] px-3 py-2 text-xs font-semibold text-slate-100">
        <button type="button" onClick={() => setExpanded(value => !value)} className="text-left">
          {isSuitePhonePage ? 'WB Suite' : 'WB Tickets'} · demo phone <span aria-hidden="true">{expanded ? '▾' : '▴'}</span>
        </button>
        <button type="button" onClick={() => { setLarge(value => !value); setExpanded(true); }} className="rounded border border-[#5a5e65] px-2 py-1 hover:bg-[#26292d]" aria-label={large ? 'Use normal phone size' : 'Enlarge demo phone'}>
          {large ? 'Normal' : 'Enlarge'}
        </button>
      </div>
      {expanded && (
        <div className="relative aspect-[9/19.5] max-h-[calc(100vh-6rem)] bg-black">
          {!isSuitePhonePage && frame.available && frame.live ? (
            <>
              <img src={frame.url} alt="Live demo driver WB Tickets screen"
                className="h-full w-full select-none object-contain" draggable={false} />
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-5 text-center text-sm text-slate-300">
              {isSuitePhonePage
                ? 'The WB Suite phone feed is not connected yet.'
                : frame.available
                  ? 'Demo driver between jobs. Waiting for the next live WB Tickets screen.'
                : checked
                  ? 'No verified demo phone screen is available yet.'
                  : 'Connecting to the demo driver’s WB Tickets app…'}
            </div>
          )}
          <div className="pointer-events-auto absolute inset-0" aria-hidden="true" />
        </div>
      )}
      </div>
    </aside>
  );
}
