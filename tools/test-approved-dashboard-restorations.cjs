const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const vm = require('node:vm'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), ts = require('typescript'), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { chromium } = require('playwright');

// Golden media are the already-approved combined desktop/Watchdog restoration.
// Updating them intentionally requires reviewing and updating this baseline.
const baseline = 'b1e45782b049475538c6ffed9fafb2c62d57b69f';
const assets = ['demo-phone/home.png', 'demo-phone/empty-drawer.png', 'demo-phone/more.png',
  'live-demo/gear-drop-white-outline-cover.png', 'live-demo/gear-drop-gold-outline-cover.png',
  'live-demo/gear-drop-gold-outline.png', 'live-demo/gear-drop-gold.png', 'live-demo/wellbuilt-logo.png'];
for (const asset of assets) {
  const expected = cp.execFileSync('git', ['show', `${baseline}:public/${asset}`]);
  assert.ok(fs.readFileSync(path.join('public', asset)).equals(expected), `Approved media changed or missing: ${asset}`);
}
const overlay = fs.readFileSync('src/components/DemoPhoneOverlay.tsx', 'utf8');
const urls = [...overlay.matchAll(/'(\/demo-phone\/[^']+\?v=[^']+)'/g)].map(m => m[1]);
assert.equal(urls.length, 3, 'Updated demo captures must use versioned URLs');
for (const value of urls) {
  const url = new URL(value, 'http://fixture');
  const hash = crypto.createHash('sha256').update(fs.readFileSync('public' + url.pathname)).digest('hex');
  assert.equal(url.searchParams.get('v'), hash.slice(0, 12), 'Capture version must identify the displayed bytes');
}
const entry = fs.readFileSync('src/app/live-demo/page.tsx', 'utf8');
assert.ok(entry.includes('src="/live-demo/gear-drop-white-outline-cover.png"'), 'Live-demo entry must retain approved white logo');
urls.push('/live-demo/gear-drop-white-outline-cover.png');

// Render the actual collapsed production card; no duplicate test layout.
const source = fs.readFileSync('src/app/dispatch/page.tsx', 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'CompletedJobsPanel');
assert.ok(declaration, 'Production completed panel absent');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(declaration.getText(ast) + '\nexports.Panel=CompletedJobsPanel;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText, { exports: exportsObject, React, useState: React.useState, useMemo: React.useMemo, useEffect: React.useEffect,
  useSearchWellStatus: () => new Map(), Date, Map, Set,
  dispatchTimestampToDate: value => value ? new Date(value) : null,
  dispatchDriverGroupKey: job => job.driverId, dispatchDriverDisplayName: job => job.driverName,
  JobTypeBadge: ({ type }) => React.createElement('span', null, type),
});
const completed = new Date(); completed.setHours(15, 19, 0, 0);
const stamp = completed.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const markup = renderToStaticMarkup(React.createElement(exportsObject.Panel, {
  jobs: [{ id: 'fixture', jobType: 'pw', status: 'completed', driverId: 'fixture-driver', driverName: 'Sample Driver',
    wellName: 'EXAMPLE WELL', disposal: 'EXAMPLE DROP-OFF', completedAt: completed.toISOString(), totalBBL: 140 }], drivers: [],
}));
const css = fs.readdirSync('out/_next/static/css').filter(f => f.endsWith('.css'))
  .map(f => fs.readFileSync(path.join('out/_next/static/css', f), 'utf8')).join('\n');
const html = `<style>${css}</style><main style="padding:12px">${markup}<section>${urls.map(url => `<img src="${url}" style="width:100px" alt="Approved demo media">`).join('')}</section></main>`;
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    if (!urls.some(value => new URL(value, 'http://fixture').pathname === url.pathname)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync('public' + url.pathname));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [344, 412, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto('http://127.0.0.1:' + server.address().port);
      const timestamp = page.getByText(stamp, { exact: true });
      await timestamp.waitFor({ state: 'visible' });
      const box = await timestamp.boundingBox();
      assert.ok(box.x < width / 2 && box.x + box.width <= width, `Full completion date/time must remain left and visible at ${width}px`);
      assert.equal(await page.locator('img').evaluateAll(images => images.filter(i => i.complete && i.naturalWidth > 0).length), 4);
      await page.close();
    }
    console.log('Approved Dashboard restoration checks passed: eight media byte matches, capture URL versions, white demo logo, and actual completed-card date/time at four widths.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
