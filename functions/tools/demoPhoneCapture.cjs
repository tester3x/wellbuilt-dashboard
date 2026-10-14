/**
 * Capture the real WB T Android screen for the public read-only demo.
 * Run on a dedicated emulator host. Frames are HMAC-authenticated to a
 * Cloud Function; neither the key nor device controls reach the browser.
 *
 *   DEMO_PHONE_UPLOAD_KEY=... node tools/demoPhoneCapture.cjs SERIAL
 */
const { spawnSync } = require('node:child_process');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');

const serial = process.argv[2];
if (!serial || !/^[a-zA-Z0-9_.:-]+$/.test(serial)) {
  console.error('Usage: node tools/demoPhoneCapture.cjs ADB_SERIAL');
  process.exit(2);
}
const uploadKey = process.env.DEMO_PHONE_UPLOAD_KEY;
if (!uploadKey || uploadKey.length < 32) {
  console.error('DEMO_PHONE_UPLOAD_KEY must match the Cloud Function secret.');
  process.exit(2);
}
const readyFile = process.env.DEMO_PHONE_READY_FILE;
if (!readyFile) {
  console.error('DEMO_PHONE_READY_FILE must name a file created only after demo driver login.');
  process.exit(2);
}

const COMPANY_ID = 'wellbuilt-demo';
const PACKAGE = 'com.testerxxx.waterticket';
const ENDPOINT = 'https://us-central1-wellbuilt-sync.cloudfunctions.net/uploadLiveDemoPhoneFrame';
const adb = process.env.ADB_PATH || 'adb';
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function call(args, timeout = 10_000) {
  const result = spawnSync(adb, ['-s', serial, ...args], {
    encoding: 'buffer', timeout, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${result.error?.message || result.stderr?.toString().trim()}`);
  }
  return result.stdout;
}

async function main() {
  if (!call(['shell', 'pm', 'path', PACKAGE]).toString().trim().startsWith('package:')) {
    throw new Error(`WB T package ${PACKAGE} is not installed on ${serial}`);
  }
  console.log(`Capturing ${PACKAGE} on ${serial} for ${COMPANY_ID}`);
  while (!stopping) {
    const started = Date.now();
    try {
      if (!existsSync(readyFile)) throw new Error('Phone stream disarmed');
      const foreground = call(['shell', 'dumpsys', 'activity', 'activities']).toString();
      if (!/topResumedActivity|mResumedActivity/.test(foreground) ||
        !foreground.split(/\r?\n/).some(line => /topResumedActivity|mResumedActivity/.test(line) && line.includes(PACKAGE))) {
        throw new Error('WB T is not the foreground app');
      }
      call(['shell', 'uiautomator', 'dump', '/sdcard/demo-window.xml'], 7_000);
      const hierarchy = call(['shell', 'cat', '/sdcard/demo-window.xml']).toString();
      if (/Driver Login|Your passcode|Register here|Set a secure password/.test(hierarchy)) {
        throw new Error('WB T login or registration screen is visible; frame withheld');
      }
      // The app can switch companies. Never stream a real customer's screen
      // merely because the demo account was active when this worker started.
      if (!hierarchy.toLowerCase().includes('wellbuilt demo hauling')) {
        throw new Error('Demo company label is absent; frame withheld');
      }
      const png = call(['exec-out', 'screencap', '-p']);
      if (!png.subarray(0, 8).equals(pngMagic) || png.length > 450_000) {
        throw new Error('Invalid or oversized Android frame');
      }
      const capturedAt = Date.now();
      const nonce = randomUUID();
      const digest = createHash('sha256').update(png).digest('hex');
      const signature = createHmac('sha256', uploadKey)
        .update(`${capturedAt}.${nonce}.${digest}`).digest('hex');
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { capturedAt, nonce, pngBase64: png.toString('base64'), signature } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Phone upload failed (${response.status})`);
      const result = await response.json();
      if (result.error || result.result?.accepted !== true) throw new Error('Phone upload was rejected');
    } catch (error) {
      console.error(error.message);
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 2_000 - (Date.now() - started))));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
