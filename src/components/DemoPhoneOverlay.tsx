'use client';

import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { usePathname } from 'next/navigation';
import { getFirebaseFunctions } from '@/lib/firebase';

type PhoneFrame = { available: false } | { available: true; url: string; capturedAt: number; live: boolean };
type ExploreScreen = 'snapshot' | 'home' | 'emptyDrawer' | 'drawer' | 'review' | 'more' | 'settings';

const exploreImages: Record<ExploreScreen, string> = {
  snapshot: '',
  home: '/demo-phone/home.png',
  emptyDrawer: '/demo-phone/empty-drawer.png',
  drawer: '/demo-phone/drawer.png',
  review: '/demo-phone/review.png',
  more: '/demo-phone/more.png',
  settings: '/demo-phone/settings.png',
};

const exploreHotspots: Partial<Record<ExploreScreen, { label: string; next: ExploreScreen; left: string; top: string; width: string; height: string }[]>> = {
  home: [
    { label: 'Open Job Drawer', next: 'emptyDrawer', left: '27%', top: '95%', width: '50%', height: '5%' },
    { label: 'Open More menu', next: 'more', left: '2%', top: '88%', width: '20%', height: '7%' },
  ],
  emptyDrawer: [{ label: 'Close Job Drawer', next: 'home', left: '5%', top: '6%', width: '90%', height: '58%' }],
  drawer: [
    { label: 'View demo job', next: 'review', left: '4%', top: '68%', width: '92%', height: '14%' },
    { label: 'Close Job Drawer', next: 'home', left: '5%', top: '6%', width: '90%', height: '58%' },
  ],
  review: [{ label: 'Back to Job Drawer', next: 'drawer', left: '1%', top: '4%', width: '14%', height: '8%' }],
  more: [
    { label: 'Open Settings', next: 'settings', left: '5%', top: '70%', width: '44%', height: '6%' },
    { label: 'Close More menu', next: 'home', left: '52%', top: '55%', width: '45%', height: '35%' },
  ],
  settings: [{ label: 'Back to cover', next: 'home', left: '1%', top: '4%', width: '14%', height: '8%' }],
};

/** The pixels come from a dedicated Android device running WB T. Viewers cannot tap it. */
export function DemoPhoneOverlay() {
  const pathname = usePathname();
  const isSuitePhonePage = pathname.startsWith('/payroll');
  const [frame, setFrame] = useState<PhoneFrame>({ available: false });
  const [checked, setChecked] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [large, setLarge] = useState(false);
  const [explore, setExplore] = useState<ExploreScreen | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);

  const openExplore = () => {
    const currentUrl = frame.available && frame.live ? frame.url : null;
    setSnapshotUrl(currentUrl);
    setExplore(currentUrl ? 'snapshot' : 'home');
    setLarge(true);
    setExpanded(true);
  };

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
          {isSuitePhonePage ? 'WB Suite' : 'WB Tickets'} · {explore ? 'phone in use' : 'live demo phone'} <span aria-hidden="true">{expanded ? '▾' : '▴'}</span>
        </button>
        <div className="flex gap-1">
          {explore ? <button type="button" onClick={() => setExplore(null)} className="rounded border border-cyan-600 px-2 py-1 text-cyan-200 hover:bg-cyan-950">Return to Live</button>
            : <button type="button" onClick={openExplore} className="rounded border border-cyan-600 px-2 py-1 text-cyan-200 hover:bg-cyan-950">Use phone</button>}
          <button type="button" onClick={() => { setLarge(value => !value); setExpanded(true); }} className="rounded border border-[#5a5e65] px-2 py-1 hover:bg-[#26292d]" aria-label={large ? 'Use normal phone size' : 'Enlarge demo phone'}>
            {large ? 'Normal' : 'Enlarge'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="relative aspect-[9/19.5] max-h-[calc(100vh-6rem)] bg-black">
          {explore ? (
            <>
              <img src={explore === 'snapshot' ? snapshotUrl || exploreImages.home : exploreImages[explore]} alt={`Captured WB Tickets demo ${explore} screen`}
                className="absolute inset-x-0 top-2 h-[calc(100%-12px)] w-full select-none object-contain" draggable={false} />
              {exploreHotspots[explore]?.map(hotspot => (
                <button key={hotspot.label} type="button" aria-label={hotspot.label}
                  onClick={() => setExplore(hotspot.next)}
                  className="absolute cursor-pointer bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
                  style={{ left: hotspot.left, top: hotspot.top, width: hotspot.width, height: hotspot.height }} />
              ))}
              <div className="absolute inset-x-2 bottom-2 flex flex-wrap justify-center gap-1 rounded bg-black/90 p-1 text-[10px]">
                <button type="button" onClick={() => setExplore('home')} className="rounded bg-slate-700 px-2 py-1">Cover</button>
                <button type="button" onClick={() => setExplore('emptyDrawer')} className="rounded bg-slate-700 px-2 py-1">Empty Drawer</button>
                <button type="button" onClick={() => setExplore('drawer')} className="rounded bg-slate-700 px-2 py-1">Sample Job</button>
                <button type="button" onClick={() => setExplore('review')} className="rounded bg-slate-700 px-2 py-1">Job Review</button>
                <button type="button" onClick={() => setExplore('more')} className="rounded bg-slate-700 px-2 py-1">More</button>
                <button type="button" onClick={() => setExplore('settings')} className="rounded bg-slate-700 px-2 py-1">Settings</button>
              </div>
            </>
          ) : !isSuitePhonePage && frame.available && frame.live ? (
            <>
              <img src={frame.url} alt="Live demo driver WB Tickets screen"
                className="absolute inset-x-0 top-2 h-[calc(100%-12px)] w-full select-none object-contain" draggable={false} />
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
          {!explore && <button type="button" aria-label="Explore the demo phone without interrupting the live driver" onClick={openExplore}
            className="absolute inset-0 cursor-pointer bg-transparent" />}
        </div>
      )}
      </div>
    </aside>
  );
}
