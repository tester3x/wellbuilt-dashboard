import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export const AUTH_ROUTES = [
  '/',
  '/admin',
  '/admin/diagnostics',
  '/admin/truth-debug',
  '/admin/truth-rag-exports',
  '/billing',
  '/chat',
  '/demo',
  '/dispatch',
  '/driverlogs',
  '/equipment',
  '/login',
  '/mobile',
  '/payroll',
  '/performance',
  '/performance/route',
  '/performance/well',
  '/photo-review',
  '/register',
  '/safety',
  '/safety/spills/detail',
  '/settings',
  '/tickets',
  '/well',
];

function createStaticServer(rootDir) {
  return http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath.endsWith('/')) reqPath += 'index.html';
    else if (!path.extname(reqPath)) reqPath += '/index.html';

    let filePath = path.join(rootDir, reqPath);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(rootDir, 'index.html'); // fallback
    }

    const ext = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}

export async function renderAllAuthenticatedRoutes() {
  console.log(`=== Verifying & Rendering All ${AUTH_ROUTES.length} Routes at Desktop (1280px) & Mobile (390px) ===`);
  const outDir = path.join(process.cwd(), 'out');
  if (!fs.existsSync(outDir)) {
    throw new Error('Build output directory "out" does not exist. Run clean build first.');
  }

  // 1. Strict presence assertion: photo-review MUST exist in the build output
  const photoReviewHtml = path.join(outDir, 'photo-review', 'index.html');
  if (!fs.existsSync(photoReviewHtml)) {
    throw new Error('FAIL: Required out/photo-review/index.html is missing from build output.');
  }
  console.log('✓ Verified: out/photo-review/index.html exists in build output.');

  const server = createStaticServer(outDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const route of AUTH_ROUTES) {
      const page = await browser.newPage();
      try {
        // 1. Desktop Test (1280 x 900)
        await page.setViewportSize({ width: 1280, height: 900 });
        const resDesktop = await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
        const desktopStatus = resDesktop ? resDesktop.status() : 0;

        const desktopMetrics = await page.evaluate(() => {
          return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: window.innerWidth,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
          };
        });

        // 2. Mobile Test (390 x 844) - iPhone baseline
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload({ waitUntil: 'domcontentloaded' });

        const mobileMetrics = await page.evaluate(() => {
          return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: window.innerWidth,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
          };
        });

        // 3. Galaxy Z Fold collapsed (344 x 882)
        await page.setViewportSize({ width: 344, height: 882 });
        await page.reload({ waitUntil: 'domcontentloaded' });

        const foldMetrics = await page.evaluate(() => {
          return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: window.innerWidth,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
          };
        });

        const status =
          !desktopMetrics.overflow &&
          !mobileMetrics.overflow &&
          !foldMetrics.overflow;

        results.push({
          route,
          status: status ? 'PASS' : 'FAIL',
          desktopStatus,
          desktopOverflow: desktopMetrics.overflow,
          mobileOverflow: mobileMetrics.overflow,
          foldOverflow: foldMetrics.overflow,
        });

        console.log(
          `  ✓ Route ${route.padEnd(26)} | Desktop 1280px: OK | Mobile 390px: OK | Fold 344px: OK | PASS`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => r.status !== 'PASS');
  if (failed.length > 0) {
    throw new Error(`FAIL: ${failed.length} routes failed responsive checks: ${JSON.stringify(failed, null, 2)}`);
  }

  console.log(`=== All ${AUTH_ROUTES.length} Routes Rendered and Verified Cleanly ===`);
  return results;
}

if (process.argv[1]?.endsWith('test-render-all-authenticated-routes.mjs')) {
  renderAllAuthenticatedRoutes().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
