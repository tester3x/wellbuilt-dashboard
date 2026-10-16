/**
 * Drives a dedicated WB Tickets Android emulator through demo-only loads.
 * The public browser never sends commands to this process. Start only after
 * verifying the emulator is signed in as a wellbuilt-demo driver.
 *
 *   DEMO_PHONE_READY_FILE=... node tools/demoPhoneDriver.cjs emulator-5554
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const sharp = require('sharp');
const { initializeApp } = require('firebase/app');
const { getFunctions, httpsCallable } = require('firebase/functions');
const { getAuth, signInWithCustomToken } = require('firebase/auth');
const { getFirestore, collection, query, where, getDocsFromServer } = require('firebase/firestore');
const { verifiedPickupDraftLog } = require('./demoPhoneMeasurement.cjs');

const serial = process.argv[2];
if (!serial || !/^[a-zA-Z0-9_.:-]+$/.test(serial)) {
  console.error('Usage: node tools/demoPhoneDriver.cjs ADB_SERIAL');
  process.exit(2);
}
const readyFile = process.env.DEMO_PHONE_READY_FILE;
if (!readyFile) {
  console.error('DEMO_PHONE_READY_FILE is required.');
  process.exit(2);
}
const adb = process.env.ADB_PATH || 'adb';
const PACKAGE = 'com.testerxxx.waterticket';
const DEMO_HEADER = 'WELLBUILT DEMO HAULING';
const DEMO_DRIVER_ID = '2f6e6f75-b468-4239-9831-71faeb623acb';
const demoApp = initializeApp({
  apiKey: 'AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI',
  authDomain: 'wellbuilt-sync.firebaseapp.com',
  projectId: 'wellbuilt-sync',
});
let viewerReady;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const arrivalDelayMs = Math.max(10_000, Number(process.env.DEMO_DRIVE_DELAY_MS) || 25_000);
let stopped = false;
let lastAction = '';
let lastActionAt = 0;
let enRouteSince = 0;
let enRouteDestination = '';
let screenshotMode = false;
let pickupEntered = false;
let pickupBlocked = false;
let currentLeg = 'pickup';
let emptyDrawerUntil = 0;
let postCloseUntil = 0;
let activeWellName = '';
let activeServiceJob = null;
const screenNames = ['home', 'enroute', 'pickup', 'dropoff', 'summary'];
let referenceScreens;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });

function call(args, timeout = 12_000) {
  const result = spawnSync(adb, ['-s', serial, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${result.error?.message || result.stderr?.trim()}`);
  }
  return result.stdout;
}
function screenshot() {
  const result = spawnSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    timeout: 12_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout?.length) {
    throw new Error(`demo phone screenshot failed: ${result.error?.message || result.stderr?.toString().trim()}`);
  }
  return result.stdout;
}
async function imageVector(bytes) {
  return sharp(bytes).resize(54, 120).removeAlpha().raw().toBuffer();
}
async function screenFromVerifiedCapture() {
  referenceScreens ||= await Promise.all(screenNames.map(name =>
    imageVector(readFileSync(join(__dirname, '..', '..', 'public', 'demo-phone', `${name}.png`)))));
  const current = await imageVector(screenshot());
  const scores = referenceScreens.map(reference => {
    let sum = 0;
    for (let index = 0; index < current.length; index++) sum += Math.abs(current[index] - reference[index]);
    return sum / current.length;
  });
  const ranked = scores.map((score, index) => ({ name: screenNames[index], score }))
    .sort((a, b) => a.score - b.score);
  // A screenshot may be mid-transition, on an unexpected app screen, or from
  // another company. Ambiguous captures must never receive a blind tap.
  if (ranked[0].score > 15 || ranked[1].score - ranked[0].score < 2) {
    console.log(new Date().toISOString(), 'ambiguous-demo-screen', ranked.map(x => `${x.name}:${x.score.toFixed(1)}`).join(' '));
    return null;
  }
  return ranked[0].name;
}
function tap(x, y) { call(['shell', 'input', 'tap', String(x), String(y)]); }
function type(value) { call(['shell', 'input', 'text', value]); }
function pauseInput(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function tapMeasurementDigit(digit) {
  const keys = {
    '0': [120, 2140], '1': [120, 1780], '2': [330, 1780],
    '3': [540, 1780], '4': [120, 1900], '5': [330, 1900],
    '6': [540, 1900], '7': [120, 2020], '8': [330, 2020],
    '9': [540, 2020],
  };
  const point = keys[digit];
  if (!point) throw new Error(`unsupported demo keypad digit: ${digit}`);
  tap(...point);
  pauseInput(700);
}
function visible(xml, value) { return xml.includes(value); }
function tapText(xml, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<node[^>]*text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
  if (!match) return false;
  tap(Math.round((Number(match[1]) + Number(match[3])) / 2),
    Math.round((Number(match[2]) + Number(match[4])) / 2));
  return true;
}
function isForeground() {
  return call(['shell', 'dumpsys', 'activity', 'activities'])
    .split(/\r?\n/).some(line => /topResumedActivity|mResumedActivity/.test(line) && line.includes(PACKAGE));
}
function ui() {
  const result = call(['shell', 'uiautomator', 'dump', '/sdcard/demo-driver-ui.xml'], 18_000);
  if (!result.includes('dumped to:')) throw new Error('Android UI was busy; no action taken');
  return call(['shell', 'cat', '/sdcard/demo-driver-ui.xml']);
}
function actOnce(key, action) {
  if (lastAction === key && Date.now() - lastActionAt < 18_000) return false;
  action();
  lastAction = key;
  lastActionAt = Date.now();
  console.log(new Date().toISOString(), key);
  return true;
}
function demoOnly(xml) {
  return visible(xml, DEMO_HEADER) || visible(xml, 'WellBuilt Demo Hauling') ||
    (visible(xml, 'Job Drawer') && visible(xml, 'Demo Operator'));
}
async function matchingPendingDemoDispatch(xml) {
  try {
    await ensureDemoViewer();
    const snapshot = await Promise.race([
      getDocsFromServer(query(
        collection(getFirestore(demoApp), 'dispatches'),
        where('companyId', '==', 'wellbuilt-demo'),
        where('status', '==', 'pending'),
      )),
      sleep(10_000).then(() => { throw new Error('demo dispatch read timed out'); }),
    ]);
    const matched = snapshot.docs.map(item => item.data()).find((job) => {
      const ordinary = job.jobType === 'pw' && /^Demo Well [1-3]$/.test(job.wellName)
        && /^Demo SWD [1-2]$/.test(job.disposal);
      const service = job.jobType === 'service' && job.serviceType === 'Hot Oiler'
        && /^Demo Service Well [12]$/.test(job.wellName)
        && /^Demo Well [1-3]$/.test(job.disposal)
        && Number.isInteger(job.bbls) && job.bbls >= 5 && job.bbls <= 120;
      return job.driverId === DEMO_DRIVER_ID && (ordinary || service)
        && xml.includes(job.wellName) && xml.includes(job.disposal);
    });
    if (matched) {
      activeWellName = matched.wellName;
      activeServiceJob = matched.jobType === 'service'
        ? { wellName: matched.wellName, disposal: matched.disposal, bbls: matched.bbls } : null;
    }
    return Boolean(matched);
  } catch (error) {
    viewerReady = undefined;
    console.warn(new Date().toISOString(), 'demo-dispatch-server-check-failed', error.message);
    return false;
  }
}
async function ensureDemoViewer() {
  viewerReady ||= (async () => {
    const session = await httpsCallable(getFunctions(demoApp, 'us-central1'), 'demoViewerSession')();
    await signInWithCustomToken(getAuth(demoApp), session.data.customToken);
  })();
  await viewerReady;
}
async function pickupPlan(xml = '') {
  if (activeServiceJob) {
    return { companyId: 'wellbuilt-demo', wellName: activeServiceJob.wellName,
      bbls: activeServiceJob.bbls, service: true };
  }
  let wellName = /text="(Demo Well [1-3])"/.exec(xml)?.[1] || activeWellName;
  if (!wellName) {
    try {
      await ensureDemoViewer();
      const snapshot = await getDocsFromServer(query(
        collection(getFirestore(demoApp), 'dispatches'),
        where('companyId', '==', 'wellbuilt-demo'),
        where('status', '==', 'in_progress'),
      ));
      const active = snapshot.docs.map(item => item.data()).find(job =>
        job.driverId === DEMO_DRIVER_ID && /^Demo Well [1-3]$/.test(job.wellName));
      wellName = active?.wellName || '';
    } catch (error) {
      console.warn(new Date().toISOString(), 'demo-active-well-unavailable', error.message);
    }
  }
  if (!wellName) return null;
  try {
    await ensureDemoViewer();
    const result = await httpsCallable(getFunctions(demoApp, 'us-central1'), 'demoWellPullPlan')({ wellName });
    const plan = result.data;
    if (plan.companyId !== 'wellbuilt-demo' || plan.wellName !== wellName || !plan.ready
      || !Number.isInteger(plan.bbls) || plan.bbls < 5 || plan.bbls > 120
      || !Number.isInteger(plan.topInches) || plan.topInches < plan.allowedBottomInches
      || plan.bottomInches < plan.allowedBottomInches - 0.1) return null;
    activeWellName = wellName;
    return plan;
  } catch (error) {
    viewerReady = undefined;
    console.warn(new Date().toISOString(), 'demo-pickup-plan-unavailable', error.message);
    return null;
  }
}
function verifiedPickupDraft(plan, startedAt) {
  // The Android input bridge can drop characters when a whole decimal is
  // injected into React Native's controlled measurement field. Read the app's
  // own live calculation and fail closed before Depart if it differs.
  const log = call(['logcat', '-d', '-v', 'epoch', '-s', 'ReactNativeJS:V']);
  return verifiedPickupDraftLog(log, plan, startedAt);
}
function typePickupPlan(plan, doneY) {
  if (plan.service) {
    tap(120, 760); type(String(plan.bbls)); tap(955, doneY);
    let entered;
    try { entered = ui(); } catch { return false; }
    const verified = visible(entered, 'AT PICKUP') && visible(entered, `text="${plan.bbls}"`);
    if (!verified) console.error(new Date().toISOString(), 'demo-service-bbls-unverified', plan.wellName, plan.bbls);
    return verified;
  }
  const startedAt = Date.now();
  const feet = Math.floor(plan.topInches / 12);
  const inches = plan.topInches % 12;
  tap(120, 760); type(String(plan.bbls)); tap(955, doneY);
  tap(120, 920); pauseInput(900);
  for (const digit of String(feet)) tapMeasurementDigit(digit);
  tap(400, 2140); pauseInput(700); // Visible SPACE key: feet then inches.
  for (const digit of String(inches)) tapMeasurementDigit(digit);
  pauseInput(500);
  if (!verifiedPickupDraft(plan, startedAt)) {
    console.error(new Date().toISOString(), 'demo-pickup-entry-unverified; driver paused at pickup',
      activeWellName, `${plan.topInches}in`, `${plan.bbls}BBL`);
    return false;
  }
  tap(955, doneY);
  console.log(new Date().toISOString(), 'demo-pickup-measurement', activeWellName,
    `${plan.topInches}in`, `${plan.bbls}BBL`, `bottom=${plan.bottomInches}in`);
  return true;
}
async function drive() {
  if (!existsSync(readyFile) || readFileSync(readyFile, 'utf8').trim() !== 'wellbuilt-demo:AntigDemoDriver') return;
  if (!isForeground()) return;
  let xml;
  if (!screenshotMode) {
    try { xml = ui(); }
    catch (error) {
      // React Native's animated navigation modal prevents uiautomator from
      // reaching an idle state. Continue only on a close visual match to a
      // verified demo capture; return to accessibility on the cover screen.
      if (!String(error.message).includes('Android UI was busy')) throw error;
      screenshotMode = true;
      console.log(new Date().toISOString(), 'android-accessibility-busy; using verified screen captures');
    }
  }
  if (!xml) {
    const screen = await screenFromVerifiedCapture();
    if (screen === 'home') {
      screenshotMode = false;
      pickupEntered = false;
      pickupBlocked = false;
      currentLeg = 'pickup';
      enRouteSince = 0;
      activeWellName = '';
      activeServiceJob = null;
    } else if (screen === 'enroute') {
      if (!enRouteSince) enRouteSince = Date.now();
      if (Date.now() - enRouteSince >= arrivalDelayMs) {
        actOnce('arrive-on-verified-route-screen', () => tap(540, 1630));
      }
    } else {
      enRouteSince = 0;
      if (screen === 'pickup' && currentLeg === 'pickup') {
        if (pickupBlocked) return;
        if (!pickupEntered) {
          const plan = await pickupPlan();
          if (plan) actOnce('enter-verified-pickup-measurement', () => {
            pickupEntered = typePickupPlan(plan, 1800);
            pickupBlocked = !pickupEntered;
          });
        } else {
          actOnce('depart-verified-pickup', () => {
            tap(540, 2320);
            currentLeg = 'dropoff';
          });
        }
      } else if (screen === 'dropoff' || (screen === 'pickup' && currentLeg === 'dropoff')) {
        // The form is nearly identical at both stops; after Depart, the
        // bottom action on this same verified layout opens Job Summary.
        actOnce('open-verified-job-summary', () => tap(540, 2320));
      } else if (screen === 'summary') {
        actOnce('confirm-verified-job-summary', () => {
          tap(750, 1780);
          postCloseUntil = Date.now() + 90_000;
        });
      }
    }
    return;
  }
  // The tab count can include an informational REMAINING-load card while no
  // dispatch is pending. Avoid repeatedly reopening that empty drawer.
  if (visible(xml, 'Job Drawer') && visible(xml, 'No pending dispatches')) {
    emptyDrawerUntil = Date.now() + 30_000;
    actOnce('close-empty-drawer', () => tap(540, 1000));
    return;
  }
  if (!demoOnly(xml)) return;
  screenshotMode = false;
  if (visible(xml, 'Electronic Ticket Book')) {
    pickupEntered = false;
    pickupBlocked = false;
    currentLeg = 'pickup';
    activeWellName = '';
    activeServiceJob = null;
  }

  if (visible(xml, 'Starting Job...')) return;

  if (visible(xml, 'Job Summary') && visible(xml, 'Close Job')) {
    actOnce('confirm-close', () => {
      tap(750, 1780);
      postCloseUntil = Date.now() + 90_000;
    });
    return;
  }
  if (visible(xml, 'Cannot Depart Yet') || visible(xml, 'Cannot Close Yet') ||
      visible(xml, 'Dispatch Link failed') || visible(xml, 'Remote acceptance was rejected') ||
      visible(xml, 'Error')) {
    console.error('Demo driver requires attention; no blind retry or bypass');
    return;
  }
  if (visible(xml, 'EN ROUTE') && visible(xml, 'Arrived (No GPS)')) {
    // The final demo location in the accessibility tree is the modal's
    // destination; earlier matches belong to the underlying ticket header.
    const locations = [...xml.matchAll(/text="(Demo (?:Service )?(?:Well|SWD) \d+)"/g)];
    const modalLocation = locations.at(-1)?.[1] || '';
    const destination = modalLocation === activeServiceJob?.disposal
      || modalLocation.startsWith('Demo SWD') ? 'dropoff' : 'pickup';
    if (enRouteDestination !== destination) {
      enRouteDestination = destination;
      enRouteSince = Date.now();
    }
    if (Date.now() - enRouteSince >= arrivalDelayMs) {
      actOnce(`arrive-${destination}`, () => {
        if (!tapText(xml, 'Arrived (No GPS)')) tap(540, destination === 'pickup' ? 1630 : 1690);
      });
    }
    return;
  }
  enRouteDestination = '';
  if (visible(xml, 'AT PICKUP') && visible(xml, 'Depart')) {
    if (pickupBlocked) return;
    if (!pickupEntered) {
      const plan = await pickupPlan(xml);
      if (plan) actOnce('enter-pickup-measurement', () => {
        // Keep the company card collapsed so the form coordinates are stable.
        if (visible(xml, 'P.O. Box 4447')) tap(540, 190);
        pickupEntered = typePickupPlan(plan, 1780);
        pickupBlocked = !pickupEntered;
      });
    } else {
      actOnce('depart-pickup', () => { if (!tapText(xml, 'Depart')) tap(540, 2320); });
    }
    return;
  }
  if (visible(xml, 'AT DROP-OFF') && visible(xml, 'Close Job')) {
    actOnce('open-job-summary', () => { if (!tapText(xml, 'Close Job')) tap(540, 2320); });
    return;
  }
  if (visible(xml, 'JOB REVIEW') && visible(xml, 'Start Job')) {
    if (Date.now() < postCloseUntil || !(await matchingPendingDemoDispatch(xml))) return;
    actOnce('start-job', () => { if (!tapText(xml, 'Start Job')) tap(700, 1750); });
    return;
  }
  if (visible(xml, 'Job Drawer') && visible(xml, 'Accept') && visible(xml, 'Demo Operator')) {
    if (Date.now() < postCloseUntil || !(await matchingPendingDemoDispatch(xml))) return;
    actOnce('accept-demo-dispatch', () => { if (!tapText(xml, 'Accept')) tap(875, 2100); });
    return;
  }
  // Match the count inside the drawer tab's own accessibility description.
  // A broad scan can catch an unrelated digit and reopen an empty drawer
  // indefinitely after a multi-load close failed to cycle on the server.
  const drawerTab = /content-desc="[^"]*Job Drawer,\s*[•·],\s*(\d+)"/.exec(xml);
  if (drawerTab && Number(drawerTab[1]) > 0 && Date.now() >= emptyDrawerUntil) {
    actOnce('open-job-drawer', () => tap(540, 2350));
  }
}

async function main() {
  if (!call(['shell', 'pm', 'path', PACKAGE]).includes('package:')) throw new Error('WB Tickets is not installed');
  console.log(`Demo-only Android driver started on ${serial}`);
  if (process.argv.includes('--once')) { await drive(); return; }
  while (!stopped) {
    try { await drive(); } catch (error) { console.error(new Date().toISOString(), error.message); }
    await sleep(4_000);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
