import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASELINE_URL = 'https://wellbuilt-sync--qa-ui-576fb63b-v3b1glwn.web.app';
const CANDIDATE_URL = 'https://wellbuilt-sync--qa-photo-review-v4-605fp6cv.web.app';

const SCREENSHOT_DIR = 'C:/Users/Michael Burger/.gemini/antigravity/brain/f3966df2-0095-4713-a527-e5b5081a57fd/screenshots';

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function inspectUrl(browser, url, label, viewport) {
  const page = await browser.newPage();
  await page.setViewportSize(viewport);

  console.log(`\nNavigating to ${url} at ${viewport.width}x${viewport.height}...`);
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(async (e) => {
    console.log(`Networkidle timeout, falling back to domcontentloaded: ${e.message}`);
    return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  });

  // Wait a moment for any client-side hydration or redirect
  await page.waitForTimeout(2000);

  const finalUrl = page.url();
  const pageTitle = await page.title();

  const metrics = await page.evaluate(() => {
    const header = document.querySelector('header');
    const nav = document.querySelector('nav');
    const h1 = document.querySelector('h1');
    const scrollWidth = document.documentElement.scrollWidth;
    const clientWidth = window.innerWidth;

    let headerMetrics = null;
    if (header) {
      const rect = header.getBoundingClientRect();
      headerMetrics = {
        height: rect.height,
        width: rect.width,
        top: rect.top,
      };
    }

    let navTabs = [];
    if (nav) {
      navTabs = Array.from(nav.querySelectorAll('a')).map((a) => ({
        text: a.textContent.trim(),
        href: a.getAttribute('href'),
      }));
    }

    return {
      finalUrl: window.location.href,
      scrollWidth,
      clientWidth,
      overflow: scrollWidth > clientWidth,
      headerMetrics,
      navTabs,
      bodyTextSnippet: document.body.innerText.slice(0, 300),
    };
  });

  const screenshotPath = path.join(SCREENSHOT_DIR, `deployed_${label}_${viewport.width}px.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Screenshot saved to ${screenshotPath}`);

  await page.close();

  return {
    label,
    url,
    viewport: `${viewport.width}x${viewport.height}`,
    finalUrl,
    pageTitle,
    metrics,
    screenshotPath,
  };
}

async function run() {
  console.log('=== Measuring Real Live Deployed HTTPS Previews ===');
  const browser = await chromium.launch({ headless: true });

  const viewports = [
    { width: 1280, height: 900, name: 'desktop' },
    { width: 390, height: 844, name: 'mobile' },
    { width: 344, height: 882, name: 'fold' },
  ];

  const results = [];

  try {
    for (const vp of viewports) {
      // 1. Baseline preview
      const baselineRes = await inspectUrl(browser, `${BASELINE_URL}/login`, `baseline_login_${vp.name}`, { width: vp.width, height: vp.height });
      results.push(baselineRes);

      // 2. Candidate preview login
      const candidateLoginRes = await inspectUrl(browser, `${CANDIDATE_URL}/login`, `candidate_login_${vp.name}`, { width: vp.width, height: vp.height });
      results.push(candidateLoginRes);

      // 3. Candidate preview photo-review route directly
      const candidatePhotoRes = await inspectUrl(browser, `${CANDIDATE_URL}/photo-review`, `candidate_photo_review_${vp.name}`, { width: vp.width, height: vp.height });
      results.push(candidatePhotoRes);
    }

    console.log('\n=== Comparison Summary ===');
    for (const r of results) {
      console.log(`\n[${r.label}] (${r.viewport})`);
      console.log(`  Final URL: ${r.finalUrl}`);
      console.log(`  Page Title: ${r.pageTitle}`);
      console.log(`  Overflow: ${r.metrics.overflow} (${r.metrics.scrollWidth}px vs ${r.metrics.clientWidth}px)`);
      if (r.metrics.headerMetrics) {
        console.log(`  Header Height: ${r.metrics.headerMetrics.height.toFixed(1)}px`);
      } else {
        console.log(`  Header: not rendered in unauthenticated view`);
      }
      if (r.metrics.navTabs.length > 0) {
        console.log(`  Nav tabs (${r.metrics.navTabs.length}): ${r.metrics.navTabs.map(t => t.text).join(', ')}`);
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
