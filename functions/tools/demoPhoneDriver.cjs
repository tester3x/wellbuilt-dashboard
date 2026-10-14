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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const arrivalDelayMs = Math.max(10_000, Number(process.env.DEMO_DRIVE_DELAY_MS) || 25_000);
let stopped = false;
let lastAction = '';
let lastActionAt = 0;
let enRouteSince = 0;
let enRouteDestination = '';
let screenshotMode = false;
let pickupEntered = false;
let currentLeg = 'pickup';
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
      currentLeg = 'pickup';
      enRouteSince = 0;
    } else if (screen === 'enroute') {
      if (!enRouteSince) enRouteSince = Date.now();
      if (Date.now() - enRouteSince >= arrivalDelayMs) {
        actOnce('arrive-on-verified-route-screen', () => tap(540, 1630));
      }
    } else {
      enRouteSince = 0;
      if (screen === 'pickup' && currentLeg === 'pickup') {
        if (!pickupEntered) {
          actOnce('enter-verified-pickup-measurement', () => {
            tap(120, 760); type('140'); tap(955, 1800);
            tap(120, 920); type('11'); tap(955, 1800); tap(955, 1800);
            pickupEntered = true;
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
        actOnce('confirm-verified-job-summary', () => tap(750, 1780));
      }
    }
    return;
  }
  // A blank bottom sheet hides the verified company header. Closing that
  // sheet cannot create or change a job; the next action rechecks the header.
  if (visible(xml, 'Job Drawer') && visible(xml, 'No pending dispatches')) {
    actOnce('close-empty-drawer', () => tap(540, 1000));
    return;
  }
  if (!demoOnly(xml)) return;
  screenshotMode = false;
  if (visible(xml, 'Electronic Ticket Book')) {
    pickupEntered = false;
    currentLeg = 'pickup';
  }

  if (visible(xml, 'Starting Job...')) return;

  if (visible(xml, 'Job Summary') && visible(xml, 'Close Job')) {
    actOnce('confirm-close', () => tap(750, 1780));
    return;
  }
  if (visible(xml, 'Cannot Depart Yet') || visible(xml, 'Cannot Close Yet') || visible(xml, 'Error')) {
    console.error('Demo driver requires attention; no blind retry or bypass');
    return;
  }
  if (visible(xml, 'EN ROUTE') && visible(xml, 'Arrived (No GPS)')) {
    // The final demo location in the accessibility tree is the modal's
    // destination; earlier matches belong to the underlying ticket header.
    const locations = [...xml.matchAll(/text="(Demo (?:Well|SWD) \d+)"/g)];
    const destination = locations.at(-1)?.[1].startsWith('Demo SWD') ? 'dropoff' : 'pickup';
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
    if (!visible(xml, '140') || !visible(xml, '11')) {
      actOnce('enter-pickup-measurement', () => {
        // Keep the company card collapsed so the form coordinates are stable.
        if (visible(xml, 'P.O. Box 4447')) tap(540, 190);
        tap(120, 760); type('140'); tap(955, 1780);
        tap(120, 920); type('11'); tap(955, 1780);
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
    actOnce('start-job', () => { if (!tapText(xml, 'Start Job')) tap(700, 1750); });
    return;
  }
  if (visible(xml, 'Job Drawer') && visible(xml, 'Accept') && visible(xml, 'Demo Operator')) {
    actOnce('accept-demo-dispatch', () => { if (!tapText(xml, 'Accept')) tap(875, 2100); });
    return;
  }
  if (/Job Drawer[^\"]*[•·][^\"]*[1-9]/.test(xml)) {
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
