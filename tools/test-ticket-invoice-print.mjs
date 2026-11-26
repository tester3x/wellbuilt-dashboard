import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const component = fs.readFileSync('src/components/TicketDetailModal.tsx', 'utf8');
assert.match(component, /createPortal\([\s\S]*document\.body/, 'Invoice modal must be a direct body child for print isolation');
assert.match(component, /ticket-invoice-modal/, 'Invoice modal must carry the print selector');

const css = fs.readFileSync('src/app/globals.css', 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <style>${css}</style>
    <div id="dashboard">${'<p>Background ticket row</p>'.repeat(700)}</div>
    <div class="ticket-invoice-modal" style="position:fixed;inset:0;overflow-y:auto">
      <div class="ticket-invoice-shell">
        <div class="ticket-invoice-header">Invoice Detail</div>
        <div class="ticket-invoice-paper"><div style="height:700px">Ticket 21207 paper detail</div></div>
      </div>
    </div>
  `);
  await page.emulateMedia({ media: 'print' });
  const styles = await page.evaluate(() => ({
    dashboard: getComputedStyle(document.querySelector('#dashboard')).display,
    modal: getComputedStyle(document.querySelector('.ticket-invoice-modal')).position,
    header: getComputedStyle(document.querySelector('.ticket-invoice-header')).display,
  }));
  assert.deepEqual(styles, { dashboard: 'none', modal: 'static', header: 'none' });
  const pdf = await page.pdf({ format: 'Letter', printBackground: true });
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  assert.equal(pageCount, 1, `Expected one paper page, got ${pageCount}`);
  console.log('Tickets invoice print: one page; 700 background rows excluded');
} finally {
  await browser.close();
}
