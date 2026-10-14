/**
 * Capture the real WB T Android screen for the public read-only demo.
 * Run on a dedicated emulator host. Frames are HMAC-authenticated to a
 * Cloud Function; neither the key nor device controls reach the browser.
 *
 *   DEMO_PHONE_UPLOAD_KEY=... node tools/demoPhoneCapture.cjs SERIAL
 */
const { spawnSync } = require('node:child_process');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const sharp = require('sharp');

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
const headerReferencePath = process.env.DEMO_PHONE_HEADER_REFERENCE;
if (!headerReferencePath || !existsSync(headerReferencePath)) {
  console.error('DEMO_PHONE_HEADER_REFERENCE must be a verified demo-company screen capture.');
  process.exit(2);
}

const COMPANY_ID = 'wellbuilt-demo';
const PACKAGE = 'com.testerxxx.waterticket';
const ENDPOINT = 'https://us-central1-wellbuilt-sync.cloudfunctions.net/uploadLiveDemoPhoneFrame';
const adb = process.env.ADB_PATH || 'adb';
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const headerRegion = { left: 320, top: 160, width: 520, height: 80 };
const headerReference = sharp(readFileSync(headerReferencePath))
  .extract(headerRegion).greyscale().raw().toBuffer();
const homeReferencePath = process.env.DEMO_PHONE_HOME_REFERENCE;
if (homeReferencePath && !existsSync(homeReferencePath)) {
  console.error('DEMO_PHONE_HOME_REFERENCE must be a verified demo-company cover capture.');
  process.exit(2);
}
const homeRegion = { left: 220, top: 710, width: 640, height: 110 };
const homeReference = homeReferencePath ? sharp(readFileSync(homeReferencePath))
  .extract(homeRegion).greyscale().raw().toBuffer() : null;
let stopping = false;
let serverClockOffsetMs = 0;
let lastError = '';
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

function meanDifference(reference, frame) {
  let total = 0;
  for (let i = 0; i < reference.length; i++) total += Math.abs(reference[i] - frame[i]);
  return total / reference.length;
}

async function main() {
  if (!call(['shell', 'pm', 'path', PACKAGE]).toString().trim().startsWith('package:')) {
    throw new Error(`WB T package ${PACKAGE} is not installed on ${serial}`);
  }
  console.log(`Capturing ${PACKAGE} on ${serial} for ${COMPANY_ID}`);
  while (!stopping) {
    const started = Date.now();
    try {
      // The arm marker and reference are created only after verifying this
      // dedicated driver's demo-company header. Check that same header in
      // every captured frame; Android accessibility dumps are too disruptive
      // to run continuously during an active job.
      if (!existsSync(readyFile) || readFileSync(readyFile, 'utf8').trim()
        !== 'wellbuilt-demo:AntigDemoDriver') throw new Error('Phone stream disarmed');
      const foreground = call(['shell', 'dumpsys', 'activity', 'activities']).toString();
      if (!/topResumedActivity|mResumedActivity/.test(foreground) ||
        !foreground.split(/\r?\n/).some(line => /topResumedActivity|mResumedActivity/.test(line) && line.includes(PACKAGE))) {
        throw new Error('WB T is not the foreground app');
      }
      const png = call(['exec-out', 'screencap', '-p']);
      if (!png.subarray(0, 8).equals(pngMagic) || png.length > 450_000) {
        throw new Error('Invalid or oversized Android frame');
      }
      const [reference, header, homeReferencePixels, homePixels] = await Promise.all([
        headerReference,
        sharp(png).extract(headerRegion).greyscale().raw().toBuffer(),
        homeReference,
        homeReference ? sharp(png).extract(homeRegion).greyscale().raw().toBuffer() : null,
      ]);
      const verifiedJobHeader = meanDifference(reference, header) <= 8;
      const verifiedHomeHeader = homeReferencePixels && homePixels &&
        meanDifference(homeReferencePixels, homePixels) <= 8;
      if (!verifiedJobHeader && !verifiedHomeHeader) {
        throw new Error('Verified demo-company header is absent; frame withheld');
      }
      const capturedAt = Date.now() + serverClockOffsetMs;
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
      // Emulator hosts can drift from Cloud Functions by more than the
      // endpoint's replay window. Learn the server clock from its HTTPS Date
      // header; the first rejected frame is retried on the next capture.
      const serverDate = Date.parse(response.headers.get('date') || '');
      if (Number.isFinite(serverDate)) serverClockOffsetMs = serverDate - Date.now();
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(`Phone upload failed (${response.status}: ${body.error?.message || 'unknown'})`);
      }
      const result = await response.json();
      if (result.error || result.result?.accepted !== true) throw new Error('Phone upload was rejected');
      if (lastError) console.log('Verified demo phone stream resumed');
      lastError = '';
    } catch (error) {
      if (error.message !== lastError) console.error(error.message);
      lastError = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 2_000 - (Date.now() - started))));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
