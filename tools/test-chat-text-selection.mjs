// Actual browser selection/default-event behavior; no real messages or accounts.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

for (const file of ['src/app/chat/page.tsx', 'src/components/chat/ChatSidebar.tsx']) {
  const code = fs.readFileSync(file, 'utf8');
  assert.equal((code.match(/onContextMenu=\{selectChatMessageText\}/g) || []).length, 2, `${file}: normal and system bubbles use native menu preparation`);
  assert.equal((code.match(/data-chat-message-text/g) || []).length, 2, `${file}: only message bodies are selected`);
}
const bundle = await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {selectChatMessageText} from './src/lib/chatTextSelection';
createRoot(document.getElementById('root')).render(<>
  <div id="first" onContextMenu={selectChatMessageText} style={{padding:30,border:'1px solid black',width:350}}>
    <span>Fixture Sender</span><p data-chat-message-text style={{whiteSpace:'pre-wrap'}}>alpha beta{'\\n'}170 BBL</p><small>12:00 PM</small>
  </div>
  <div id="second" onContextMenu={selectChatMessageText} style={{padding:30,border:'1px solid black',width:350}}><p data-chat-message-text>Second fixture message</p></div>
  <div id="photo" onContextMenu={selectChatMessageText}><a href="#photo"><img alt="Fixture photo" width="50" height="50" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='50' height='50'%3E%3C/svg%3E"/></a></div>
  <div id="empty" onContextMenu={selectChatMessageText}><p data-chat-message-text> </p></div>
</>);
document.addEventListener('contextmenu', event=>{window.menuAllowed=!event.defaultPrevented;});
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].contents : '<div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const first = page.locator('#first');
  await first.click({ button: 'right', position: { x: 8, y: 8 } });
  assert.equal(await page.evaluate(() => getSelection().toString()), 'alpha beta\n170 BBL', 'right-clicking bubble padding selects full message, excluding sender and time');
  assert.equal(await page.evaluate(() => window.menuAllowed), true, 'browser context menu default remains enabled');
  const point = await page.evaluate(() => {
    const text = document.querySelector('#first [data-chat-message-text]').firstChild;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  assert.equal(await page.evaluate(() => getSelection().toString()), 'alpha', 'deliberate partial selection is preserved');
  await page.locator('#second').click({ button: 'right', position: { x: 8, y: 8 } });
  assert.equal(await page.evaluate(() => getSelection().toString()), 'Second fixture message', 'right-clicking another bubble selects that message');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator('#photo img').click({ button: 'right' });
  assert.equal(await page.evaluate(() => getSelection().toString()), '', 'photo/link context menu is not turned into text selection');
  assert.equal(await page.evaluate(() => window.menuAllowed), true);
  await page.locator('#empty').dispatchEvent('contextmenu');
  assert.equal(await page.evaluate(() => getSelection().toString()), '');
  console.log('Chat native menu: bubble right-click selects message only, preserves partial selection/newlines, allows browser menu, and leaves photos/links unchanged.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
