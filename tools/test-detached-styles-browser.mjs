// Browser regression: an old dashboard tab must style both pop-outs even when
// its original hashed CSS file has disappeared after a Hosting release.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { copyStyles } from '../src/components/detachedStyles.ts';

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  let cssAvailable = true;
  await context.route('https://wellbuilt.test/**', route => {
    const url = route.request().url();
    if (url.endsWith('/old-hash.css')) {
      return cssAvailable
        ? route.fulfill({ contentType: 'text/css', body: '.well-queue,.active-jobs{background-color:rgb(17,24,39);color:rgb(255,255,255)}' })
        : route.fulfill({ status: 404, body: 'removed by deploy' });
    }
    return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/old-hash.css"><body></body>' });
  });
  const page = await context.newPage();
  await page.goto('https://wellbuilt.test/');
  await page.waitForFunction(() => document.styleSheets.length === 1 && document.styleSheets[0].cssRules.length === 1);
  cssAvailable = false;
  const popupEvent = page.waitForEvent('popup');
  await page.evaluate(source => {
    const popup = window.open('', 'detached-styles-regression');
    if (!popup) throw new Error('popup blocked');
    const mirror = Function(`return (${source})`)();
    mirror(document, popup.document);
    popup.document.body.innerHTML = '<div class="well-queue">Well Queue</div><div class="active-jobs">Active Jobs</div>';
  }, copyStyles.toString());
  const popup = await popupEvent;
  const result = await popup.evaluate(() => ({
    queue: getComputedStyle(document.querySelector('.well-queue')).backgroundColor,
    jobs: getComputedStyle(document.querySelector('.active-jobs')).backgroundColor,
    linkedStyles: document.querySelectorAll('link[rel="stylesheet"]').length,
  }));
  assert.deepEqual(result, { queue: 'rgb(17, 24, 39)', jobs: 'rgb(17, 24, 39)', linkedStyles: 0 });
  console.log('PASS: both detached panes retain loaded styles after the CSS URL is removed');
} finally {
  await browser.close();
}
