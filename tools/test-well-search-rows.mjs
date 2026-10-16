import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';

// Render the actual production components and pure projection code. No Firebase
// reads or customer fixtures are required for this responsive layout check.
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (!path.extname(file)) file += fs.existsSync(file + '.tsx') ? '.tsx' : '.ts';
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const require = name => name === 'react' ? React : load(name.startsWith('@/')
    ? path.join(process.cwd(), 'src', name.slice(2)) : path.resolve(path.dirname(file), name));
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require, React, Date, Map, Set, console }, { filename: file });
  return module.exports;
}
const { LocationSearchResult } = load('src/components/LocationSearchResult.tsx');
const { WellSearchStatusProvider } = load('src/components/WellSearchStatus.tsx');
const now = Date.UTC(2026, 0, 1, 12);
const names = ['LONG EXAMPLE FEDERAL 7-36-25TFH', 'EXAMPLE DOWN 3-36-25H', 'UNMAINTAINED CATALOG WELL'];
const wells = names.slice(0, 2).map((wellName, i) => ({ wellName, currentLevel: "8'", lastPullBottomLevel: "8'",
  flowRate: '1:00:00', timestamp: new Date(now).toISOString(), lastPullDateTimeUTC: new Date(now).toISOString(),
  tanks: 1, bottomLevel: 1, wellDown: i === 1 }));
const html = renderToStaticMarkup(React.createElement(WellSearchStatusProvider, { wells, nowMs: now },
  names.map(name => React.createElement('button', { key: name, className: 'wb-option-row w-full px-3' },
    React.createElement(LocationSearchResult, { item: { label: name, value: name, sub: 'EXAMPLE OPERATOR COMPANY, INC.', kind: 'WELL' } })))));
const css = fs.readdirSync('out/_next/static/css').filter(f => f.endsWith('.css'))
  .map(f => fs.readFileSync(path.join('out/_next/static/css', f), 'utf8')).join('\n');
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 344, 600, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: 600 } });
    await page.setContent(`<style>${css}</style><body style="margin:0;background:#111827"><main style="padding:12px">${html}</main></body>`);
    const result = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      rows: [...document.querySelectorAll('button')].map(button => {
        const level = button.querySelector('[title="WB Mobile estimated level"]');
        const name = button.querySelector('span.block.text-sm');
        return { level: level?.textContent, overlap: !!level && name.getBoundingClientRect().right > level.getBoundingClientRect().left + 1,
          escaped: !!level && level.getBoundingClientRect().right > button.getBoundingClientRect().right };
      }),
    }));
    assert.equal(result.overflow, false);
    assert.equal(result.rows[0].level, "8'");
    assert.match(result.rows[1].level, /^DOWN/);
    assert.equal(result.rows[2].level, undefined);
    assert.ok(result.rows.every(row => !row.overlap && !row.escaped));
    console.log(`PASS ${width}px: right-side levels fit, DOWN shown, unknown omitted`);
    await page.close();
  }
} finally { await browser.close(); }
