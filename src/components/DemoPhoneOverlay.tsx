'use client';

import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { usePathname } from 'next/navigation';
import { getFirebaseFunctions } from '@/lib/firebase';

type PhoneFrame = { available: false } | { available: true; url: string; capturedAt: number; live: boolean };
type ExploreScreen = 'home' | 'emptyDrawer' | 'drawer' | 'review' | 'enroute' | 'pickup' | 'dropoff' | 'summary' | 'more' | 'settings';
type PhoneTourStep = 'waiting' | 'drawer' | 'review';

const exploreImages: Record<ExploreScreen, string> = {
  home: '/demo-phone/home.png',
  emptyDrawer: '/demo-phone/empty-drawer.png',
  drawer: '/demo-phone/drawer.png',
  review: '/demo-phone/review.png',
  enroute: '/demo-phone/enroute.png',
  pickup: '/demo-phone/pickup.png',
  dropoff: '/demo-phone/dropoff.png',
  summary: '/demo-phone/summary.png',
  more: '/demo-phone/more.png',
  settings: '/demo-phone/settings.png',
};

const screenNames = Object.keys(exploreImages) as ExploreScreen[];
type ImageVector = Uint8ClampedArray;
type RecognizedScreen = { capturedAt: number; screen: ExploreScreen | null; reviewButton?: { top: string; height: string } };
let referenceVectors: Promise<ImageVector[]> | null = null;

async function imageVector(url: string): Promise<ImageVector> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 54;
  canvas.height = 120;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Demo phone image comparison is unavailable');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function findReviewButton(pixels: ImageVector): RecognizedScreen['reviewButton'] {
  // Job Review grows when dispatch notes are present. Find the filled teal
  // action button in this actual frame instead of reusing capture coordinates.
  let first = -1;
  let last = -1;
  for (let y = 55; y < 108; y++) {
    let teal = 0;
    for (let x = 19; x < 52; x++) {
      const i = (y * 54 + x) * 4;
      if (pixels[i] < 40 && pixels[i + 1] >= 85 && pixels[i + 1] < 190
        && pixels[i + 2] >= 110 && pixels[i + 2] < 230) teal++;
    }
    if (teal >= 18) {
      if (first < 0) first = y;
      last = y;
    } else if (first >= 0 && last - first >= 3) break;
    else if (first >= 0) first = last = -1;
  }
  if (first < 0 || last - first < 3 || last - first > 13) return undefined;
  return { top: `${(first - 1) / 120 * 100}%`, height: `${(last - first + 3) / 120 * 100}%` };
}

function hasDrawerAccept(pixels: ImageVector): boolean {
  // The well name, destination and flow estimate change on every real DDJD
  // card. Recognize its fixed teal Accept button when those text differences
  // make the empty-drawer reference score slightly closer.
  let filledRows = 0;
  for (let y = 99; y < 110; y++) {
    let teal = 0;
    for (let x = 34; x < 52; x++) {
      const i = (y * 54 + x) * 4;
      if (pixels[i] < 40 && pixels[i + 1] >= 85 && pixels[i + 1] < 190
        && pixels[i + 2] >= 110 && pixels[i + 2] < 230) teal++;
    }
    if (teal >= 8) filledRows++;
  }
  return filledRows >= 3;
}

async function identifyPhoneScreen(url: string): Promise<{ screen: ExploreScreen | null; reviewButton?: RecognizedScreen['reviewButton'] }> {
  referenceVectors ||= Promise.all(screenNames.map(name => imageVector(exploreImages[name])))
    .catch(error => { referenceVectors = null; throw error; });
  const [current, references] = await Promise.all([imageVector(url), referenceVectors]);
  const ranked = references.map((reference, index) => {
    let difference = 0;
    for (let pixel = 0; pixel < current.length; pixel += 4) {
      difference += Math.abs(current[pixel] - reference[pixel]);
      difference += Math.abs(current[pixel + 1] - reference[pixel + 1]);
      difference += Math.abs(current[pixel + 2] - reference[pixel + 2]);
    }
    return { screen: screenNames[index], score: difference / (current.length * 0.75) };
  }).sort((a, b) => a.score - b.score);
  // A transition or an unfamiliar Android screen should never acquire guessed controls.
  let screen = ranked[0].score <= 15 && ranked[1].score - ranked[0].score >= 2
    ? ranked[0].screen : null;
  if (!screen && ranked[0].score <= 15 && ranked[0].screen === 'emptyDrawer'
    && ranked[1].screen === 'drawer' && hasDrawerAccept(current)) screen = 'drawer';
  return { screen, reviewButton: screen === 'review' ? findReviewButton(current) : undefined };
}

const exploreHotspots: Partial<Record<ExploreScreen, { label: string; next: ExploreScreen; left: string; top: string; width: string; height: string }[]>> = {
  home: [
    { label: 'Open Job Drawer', next: 'emptyDrawer', left: '27%', top: '95%', width: '48%', height: '5%' },
    { label: 'Open More menu', next: 'more', left: '3%', top: '90%', width: '13%', height: '5%' },
  ],
  emptyDrawer: [{ label: 'Close Job Drawer', next: 'home', left: '0%', top: '0%', width: '100%', height: '74%' }],
  drawer: [
    { label: 'Accept demo job', next: 'review', left: '70%', top: '84%', width: '24%', height: '8%' },
    { label: 'Close Job Drawer', next: 'home', left: '0%', top: '0%', width: '100%', height: '74%' },
  ],
  review: [
    { label: 'Back to Job Drawer', next: 'drawer', left: '1%', top: '5%', width: '12%', height: '8%' },
    { label: 'Cancel demo job review', next: 'drawer', left: '4%', top: '68%', width: '27%', height: '9%' },
    { label: 'Start demo job preview', next: 'enroute', left: '34%', top: '68%', width: '63%', height: '9%' },
  ],
  enroute: [{ label: 'Arrive at demo well', next: 'pickup', left: '12%', top: '65%', width: '76%', height: '9%' }],
  pickup: [
    { label: 'Depart demo well', next: 'dropoff', left: '34%', top: '94%', width: '34%', height: '6%' },
    { label: 'Open More menu', next: 'more', left: '70%', top: '94%', width: '24%', height: '6%' },
  ],
  dropoff: [
    { label: 'View demo job summary', next: 'summary', left: '34%', top: '94%', width: '34%', height: '6%' },
    { label: 'Open More menu', next: 'more', left: '70%', top: '94%', width: '24%', height: '6%' },
  ],
  summary: [
    { label: 'Close demo job preview', next: 'home', left: '51%', top: '73%', width: '43%', height: '8%' },
    { label: 'Cancel demo job summary', next: 'dropoff', left: '11%', top: '73%', width: '39%', height: '8%' },
  ],
  more: [
    { label: 'Open Settings', next: 'settings', left: '5%', top: '72%', width: '42%', height: '7%' },
    { label: 'Close More menu', next: 'home', left: '52%', top: '54%', width: '43%', height: '39%' },
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
  const [minimized, setMinimized] = useState(() => !pathname.startsWith('/dispatch'));
  const [large, setLarge] = useState(false);
  const [explore, setExplore] = useState<ExploreScreen | null>(null);
  const [phoneTourStep, setPhoneTourStep] = useState<PhoneTourStep | null>(null);
  const [phoneTourStartedAt, setPhoneTourStartedAt] = useState(0);
  const [recognized, setRecognized] = useState<RecognizedScreen | null>(null);
  const [clockNow, setClockNow] = useState(0);
  const liveScreen = frame.available && recognized?.capturedAt === frame.capturedAt ? recognized.screen : null;
  const statusTime = clockNow ? new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(frame.available && frame.live ? frame.capturedAt : clockNow).replace(/\s[AP]M$/, '') : '';

  useEffect(() => {
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // Keep the driver visible for the dispatch walkthrough, while letting
    // visitors read the full tables on the other Dashboard pages.
    setMinimized(!pathname.startsWith('/dispatch'));
  }, [pathname]);

  const openExplore = (screen: ExploreScreen) => {
    // Explore a separate captured WB T session. The live driver keeps running
    // for every viewer and never receives public-browser taps.
    setExplore(screen);
    setPhoneTourStep(null);
    setLarge(true);
    setExpanded(true);
  };

  useEffect(() => {
    const startPhoneTour = () => {
      setExplore(null);
      setMinimized(false);
      setExpanded(true);
      setLarge(true);
      setPhoneTourStartedAt(Date.now());
      setPhoneTourStep('waiting');
    };
    window.addEventListener('wellbuilt:demo-phone-tour', startPhoneTour);
    return () => window.removeEventListener('wellbuilt:demo-phone-tour', startPhoneTour);
  }, []);

  useEffect(() => {
    if (!phoneTourStep) return;
    const timer = window.setTimeout(() => setPhoneTourStep(null), 90_000);
    return () => window.clearTimeout(timer);
  }, [phoneTourStep]);

  useEffect(() => {
    // The dedicated Android stream and browser can disagree on wall time by
    // several seconds. Follow a fresh, live screen transition with tolerance.
    if (!phoneTourStep || !liveScreen || explore || !frame.available || !frame.live
      || frame.capturedAt <= phoneTourStartedAt - 45_000) return;
    if (liveScreen === 'drawer') setPhoneTourStep('drawer');
    else if (liveScreen === 'review') setPhoneTourStep('review');
    else if (liveScreen === 'enroute' || liveScreen === 'pickup' || liveScreen === 'dropoff') setPhoneTourStep(null);
  }, [explore, frame, liveScreen, phoneTourStartedAt, phoneTourStep]);

  useEffect(() => {
    if (!frame.available || !frame.live) return;
    let alive = true;
    void identifyPhoneScreen(frame.url)
      .then(result => { if (alive) setRecognized({ capturedAt: frame.capturedAt, ...result }); })
      .catch(() => { if (alive) setRecognized({ capturedAt: frame.capturedAt, screen: null }); });
    return () => { alive = false; };
  }, [frame]);

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

  if (minimized) {
    return (
      <button type="button" onClick={() => setMinimized(false)}
        aria-label="Show demo phone"
        className="fixed bottom-4 right-4 z-[85] flex items-center gap-2 rounded-full border border-cyan-600 bg-[#121417] px-4 py-2 text-xs font-semibold text-cyan-100 shadow-lg shadow-black/50 hover:bg-cyan-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${!isSuitePhonePage && frame.available && frame.live ? 'bg-emerald-400' : 'bg-slate-500'}`} />
        Show demo phone
      </button>
    );
  }

  return (
    <aside aria-label="Live WellBuilt demo phone" className="fixed bottom-3 right-3 z-[85] rounded-[38px] border-[10px] border-[#17191d] bg-[#090a0c] p-[4px] shadow-[inset_0_0_0_2px_#373a40,0_18px_42px_#000b,4px_4px_0_#08090a] ring-2 ring-[#34363b] md:bottom-5 md:right-5"
      style={{ width: large ? 'min(90vw, 480px, calc((100dvh - 8rem) * 9 / 20))' : 'min(90vw, 370px, calc((100dvh - 8rem) * 9 / 20))' }}>
      <span aria-hidden="true" className="absolute -left-[13px] top-[19%] h-16 w-[5px] rounded-l bg-[#34363b] shadow-[inset_1px_0_#63676b]" />
      <span aria-hidden="true" className="absolute -left-[13px] top-[31%] h-10 w-[5px] rounded-l bg-[#34363b] shadow-[inset_1px_0_#63676b]" />
      <span aria-hidden="true" className="absolute -right-[13px] top-[25%] h-20 w-[5px] rounded-r bg-[#34363b] shadow-[inset_-1px_0_#63676b]" />
      <div className="overflow-hidden rounded-[27px] border-[3px] border-[#3a3d42] bg-black shadow-[inset_0_0_0_2px_#0c0d0f]">
      <div className="flex h-[42px] w-full items-center justify-between gap-1.5 bg-[#121417] px-2 text-[11px] font-semibold text-slate-100">
        <button type="button" onClick={() => setExpanded(value => !value)} className="min-w-0 truncate whitespace-nowrap text-left">
          {isSuitePhonePage ? 'WB Suite' : 'WB Tickets'} · {explore ? 'phone in use' : frame.available && frame.live ? 'live demo phone' : 'captured phone preview'} <span aria-hidden="true">{expanded ? '▾' : '▴'}</span>
        </button>
        <div className="flex shrink-0 gap-1 whitespace-nowrap">
          {explore && <button type="button" onClick={() => setExplore(null)} className="rounded border border-cyan-600 px-1.5 py-1 text-cyan-200 hover:bg-cyan-950">Return to Live</button>}
          <button type="button" onClick={() => setMinimized(true)} className="rounded border border-[#5a5e65] px-1.5 py-1 hover:bg-[#26292d]" aria-label="Minimize demo phone">Hide</button>
          <button type="button" onClick={() => { setLarge(value => !value); setExpanded(true); }} className="rounded border border-[#5a5e65] px-1.5 py-1 hover:bg-[#26292d]" aria-label={large ? 'Use normal phone size' : 'Enlarge demo phone'}>
            {large ? 'Normal' : 'Enlarge'}
          </button>
        </div>
      </div>
      {phoneTourStep && !explore && (
        <div aria-live="polite" className="border-y border-cyan-700 bg-cyan-950 px-3 py-2 text-center text-xs font-semibold text-cyan-100">
          {phoneTourStep === 'waiting' ? 'Phone in use · driver opens DDJD for the new job'
            : phoneTourStep === 'drawer' ? 'DDJD open · driver taps Accept'
              : 'Job accepted · Job Review is on the phone'}
        </div>
      )}
      {expanded && (
        <div className="relative mt-6 aspect-[9/20] bg-black">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[3.8%] items-center justify-between bg-black px-[5%] text-xs font-medium leading-none text-white">
            <span className="tabular-nums">{statusTime}</span>
            <span className="flex items-center gap-1">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 5.2a11.2 11.2 0 0 1 14 0L8 13.8 1 5.2Z" /></svg>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 14h14V2L1 14Z" /></svg>
              <svg width="13" height="14" viewBox="0 0 14 16" fill="none"><rect x="1" y="2" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" /><path d="M4 1h5M6.5 5l-2 4h2l-.5 3 3-5H7l.5-2Z" fill="currentColor" /></svg>
            </span>
          </div>
          {explore ? (
            <>
              <img src={exploreImages[explore]} alt={`Captured WB Tickets demo ${explore} screen`}
                className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} />
              {exploreHotspots[explore]?.map(hotspot => (
                <button key={hotspot.label} type="button" aria-label={hotspot.label}
                  onClick={() => setExplore(hotspot.next)}
                  className="absolute cursor-pointer bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
                  style={{ left: hotspot.left, top: hotspot.top, width: hotspot.width, height: hotspot.height }} />
              ))}
            </>
          ) : !isSuitePhonePage && frame.available && frame.live ? (
            <>
              <img src={frame.url} alt="Live demo driver WB Tickets screen"
                className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} />
              {liveScreen && exploreHotspots[liveScreen]?.filter(hotspot =>
                liveScreen !== 'review' || hotspot.label === 'Back to Job Drawer' || recognized?.reviewButton
              ).map(hotspot => (
                <button key={hotspot.label} type="button" aria-label={`${hotspot.label} on the demo phone`}
                  onClick={() => openExplore(hotspot.next)}
                  className={`absolute cursor-pointer bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                    (phoneTourStep === 'waiting' && liveScreen === 'home' && hotspot.label === 'Open Job Drawer')
                    || (phoneTourStep === 'drawer' && liveScreen === 'drawer' && hotspot.label === 'Accept demo job')
                    || (phoneTourStep === 'review' && liveScreen === 'review' && hotspot.label === 'Start demo job preview')
                      ? 'rounded-lg ring-2 ring-cyan-300 shadow-[0_0_18px_#22d3ee]' : ''}`}
                  style={{ left: hotspot.left,
                    top: liveScreen === 'review' && hotspot.label !== 'Back to Job Drawer' ? recognized?.reviewButton?.top : hotspot.top,
                    width: hotspot.width,
                    height: liveScreen === 'review' && hotspot.label !== 'Back to Job Drawer' ? recognized?.reviewButton?.height : hotspot.height }} />
              ))}
            </>
          ) : !isSuitePhonePage && checked ? (
            <>
              <img src={exploreImages.home} alt="Captured WB Tickets demo cover while the live phone is unavailable"
                className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} />
              {exploreHotspots.home?.map(hotspot => (
                <button key={hotspot.label} type="button" aria-label={`${hotspot.label} on the captured demo phone`}
                  onClick={() => openExplore(hotspot.next)}
                  className="absolute cursor-pointer bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
                  style={{ left: hotspot.left, top: hotspot.top, width: hotspot.width, height: hotspot.height }} />
              ))}
              <div className="pointer-events-none absolute left-1/2 top-[6%] -translate-x-1/2 rounded-full border border-slate-600 bg-black/85 px-2 py-1 text-center text-[10px] font-semibold text-slate-200">
                Live phone offline · captured screen
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-5 text-center text-sm text-slate-300">
              {isSuitePhonePage
                ? 'The WB Suite phone feed is not connected yet.'
                : 'Connecting to the demo driver’s WB Tickets app…'}
            </div>
          )}
        </div>
      )}
      </div>
    </aside>
  );
}
