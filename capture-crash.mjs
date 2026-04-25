import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:4000/chat/';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
const consoleMsgs = [];
page.on('console', msg => consoleMsgs.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', err => errors.push({ message: err.message, stack: err.stack }));
page.on('requestfailed', req => errors.push({ type: 'requestfailed', url: req.url(), err: req.failure()?.errorText }));
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(3000);
} catch (e) {
  errors.push({ type: 'navigation', message: e.message });
}
const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => '');
const html = await page.content().catch(() => '');
const hasAppError = html.includes('Application error') || bodyText.includes('Application error');
console.log(JSON.stringify({ url, hasAppError, bodyText, errors, consoleMsgs: consoleMsgs.filter(m => m.type === 'error' || m.type === 'warning').slice(0, 20) }, null, 2));
await browser.close();
