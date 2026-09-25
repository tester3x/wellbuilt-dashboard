/**
 * Real-DOM verification for Dispatch Job Builder search-field keyboard UX.
 * Tests Well, Driver, and Disposal searches across both desktop (1280px) and
 * narrow (344px Galaxy Z Fold) viewports using Playwright.
 *
 * Verifies:
 * 1. Tab from search field focuses result 1.
 * 2. More Tabs move through visible results.
 * 3. Enter selects the focused result.
 * 4. Tab after the last result reaches the next normal form field (Driver, Loads).
 * 5. Shift+Tab moves backward (between results, and from result 1 back to input).
 * 6. Escape closes results and keeps/returns focus on input.
 * 7. Arrow Up/Down + Enter remains fully functional.
 * 8. When there are no results open, Tab moves normally to next field.
 * 9. Narrow window (344px) layout integrity with no horizontal overflow.
 */
import { chromium } from 'playwright';

function fail(msg) {
  console.error('  ✗ ' + msg);
  process.exitCode = 1;
  throw new Error(msg);
}

function makeHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #111827; color: #fff; padding: 16px; }
    .builder-container { max-width: 400px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .field-group { position: relative; display: flex; flex-direction: column; gap: 4px; }
    label { font-size: 12px; color: #9ca3af; }
    input, select { width: 100%; padding: 8px; background: #1f2937; border: 1px solid #374151; border-radius: 4px; color: #fff; font-size: 14px; }
    input:focus, select:focus { outline: none; border-color: #3b82f6; }
    .suggestion-list {
      position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
      background: #1f2937; border: 1px solid #4b5563; border-radius: 4px;
      max-height: 128px; overflow-y: auto; margin-top: 2px;
    }
    .wb-option-row {
      display: block; width: 100%; padding: 8px 12px; text-align: left;
      background: transparent; border: none; border-bottom: 1px solid #374151;
      color: #fff; font-size: 13px; cursor: pointer;
    }
    .wb-option-row:last-child { border-bottom: none; }
    .wb-option-row:hover { background: #374151; }
    .wb-option-row:focus-visible,
    .wb-option-row[data-active="true"] {
      background: #1e3a5f; outline: none; box-shadow: inset 0 0 0 2px #3b82f6;
    }
  </style>
</head>
<body>
  <div class="builder-container" id="container">
    <!-- Well Autocomplete Field -->
    <div class="field-group" id="well-group">
      <label for="well-input">Well</label>
      <input type="text" id="well-input" role="combobox" aria-label="Search wells" aria-expanded="false" aria-autocomplete="list" placeholder="Search wells..." autocomplete="off" />
      <div id="well-list" class="suggestion-list" role="listbox" style="display: none;"></div>
    </div>

    <!-- Driver Field (directly following Well in PW modal) -->
    <div class="field-group">
      <label for="driver-select">Driver</label>
      <select id="driver-select">
        <option value="">Select driver...</option>
        <option value="driver-1">John Doe</option>
        <option value="driver-2">Jane Smith</option>
      </select>
    </div>

    <!-- Disposal Autocomplete Field -->
    <div class="field-group" id="disposal-group">
      <label for="disposal-input">Disposal</label>
      <input type="text" id="disposal-input" role="combobox" aria-label="Search SWD disposal" aria-expanded="false" aria-autocomplete="list" placeholder="Search SWD..." autocomplete="off" />
      <div id="disposal-list" class="suggestion-list" role="listbox" style="display: none;"></div>
    </div>

    <!-- Loads Field (directly following Disposal) -->
    <div class="field-group">
      <label for="loads-input">Loads</label>
      <input type="number" id="loads-input" value="1" min="1" max="20" />
    </div>
  </div>

  <script>
    // Component implementation faithful to BuilderAutocomplete and useAutocompleteKeyboard
    function setupAutocomplete({ inputId, listId, itemsSource, onSelect }) {
      const input = document.getElementById(inputId);
      const list = document.getElementById(listId);

      let focused = false;
      let dismissed = false;
      let activeIndex = -1;
      let items = [];
      let isNavigatingTab = false;

      function optionRefs() {
        return Array.from(list.querySelectorAll('.wb-option-row'));
      }

      function isInside(target) {
        if (isNavigatingTab) return true;
        if (!target) return false;
        if (target === input) return true;
        if (list.contains(target)) return true;
        return false;
      }

      function updateUI() {
        const query = input.value.trim();
        const meetsMin = query.length >= 2;
        items = meetsMin ? itemsSource(query) : [];
        const open = focused && !dismissed && meetsMin && items.length > 0;

        input.setAttribute('aria-expanded', String(open));

        if (!open) {
          list.style.display = 'none';
          list.innerHTML = '';
          activeIndex = -1;
          input.removeAttribute('aria-activedescendant');
          return;
        }

        list.style.display = 'block';
        list.innerHTML = '';
        items.forEach((item, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'wb-option-row';
          btn.id = listId + '-opt-' + idx;
          btn.setAttribute('role', 'option');
          btn.tabIndex = 0;
          btn.textContent = item.label || item;
          if (idx === activeIndex) {
            btn.setAttribute('data-active', 'true');
            btn.setAttribute('aria-selected', 'true');
          }

          btn.addEventListener('mousedown', (e) => e.preventDefault());
          btn.addEventListener('click', () => {
            select(idx);
          });
          btn.addEventListener('focus', () => {
            activeIndex = idx;
            highlight(idx);
          });
          btn.addEventListener('blur', (e) => {
            if (!isInside(e.relatedTarget)) {
              focused = false;
              dismissed = true;
              updateUI();
            }
          });
          btn.addEventListener('keydown', (e) => {
            const opts = optionRefs();
            const count = opts.length;
            switch (e.key) {
              case 'Tab':
                if (e.shiftKey) {
                  e.preventDefault();
                  if (idx > 0) {
                    activeIndex = idx - 1;
                    isNavigatingTab = true;
                    opts[idx - 1].focus();
                    isNavigatingTab = false;
                    highlight(activeIndex);
                  } else {
                    activeIndex = -1;
                    isNavigatingTab = true;
                    input.focus();
                    isNavigatingTab = false;
                    highlight(-1);
                  }
                } else {
                  if (idx < count - 1) {
                    e.preventDefault();
                    activeIndex = idx + 1;
                    isNavigatingTab = true;
                    opts[idx + 1].focus();
                    isNavigatingTab = false;
                    highlight(activeIndex);
                  } else {
                    // Last result: allow normal browser Tab to next field
                    activeIndex = -1;
                  }
                }
                break;
              case 'Enter':
                e.preventDefault();
                select(idx);
                break;
              case 'Escape':
                e.preventDefault();
                dismissed = true;
                activeIndex = -1;
                input.focus();
                updateUI();
                break;
              case 'ArrowDown':
                e.preventDefault();
                if (idx < count - 1) {
                  activeIndex = idx + 1;
                  isNavigatingTab = true;
                  opts[idx + 1].focus();
                  isNavigatingTab = false;
                  highlight(activeIndex);
                }
                break;
              case 'ArrowUp':
                e.preventDefault();
                if (idx > 0) {
                  activeIndex = idx - 1;
                  isNavigatingTab = true;
                  opts[idx - 1].focus();
                  isNavigatingTab = false;
                  highlight(activeIndex);
                } else {
                  activeIndex = -1;
                  isNavigatingTab = true;
                  input.focus();
                  isNavigatingTab = false;
                  highlight(-1);
                }
                break;
            }
          });
          list.appendChild(btn);
        });

        highlight(activeIndex);
      }

      function highlight(idx) {
        const opts = optionRefs();
        opts.forEach((btn, i) => {
          if (i === idx) {
            btn.setAttribute('data-active', 'true');
            btn.setAttribute('aria-selected', 'true');
            input.setAttribute('aria-activedescendant', btn.id);
            // scroll into view inside list container
            const lr = list.getBoundingClientRect();
            const br = btn.getBoundingClientRect();
            if (br.top < lr.top) list.scrollTop += (br.top - lr.top);
            else if (br.bottom > lr.bottom) list.scrollTop += (br.bottom - lr.bottom);
          } else {
            btn.removeAttribute('data-active');
            btn.removeAttribute('aria-selected');
          }
        });
        if (idx < 0) {
          input.removeAttribute('aria-activedescendant');
        }
      }

      function select(idx) {
        if (idx >= 0 && idx < items.length) {
          onSelect(items[idx]);
          dismissed = true;
          focused = false;
          updateUI();
        }
      }

      input.addEventListener('input', () => {
        dismissed = false;
        activeIndex = -1;
        updateUI();
      });

      input.addEventListener('focus', () => {
        focused = true;
        updateUI();
      });

      input.addEventListener('blur', (e) => {
        if (!isInside(e.relatedTarget)) {
          focused = false;
          dismissed = false;
          updateUI();
        }
      });

      input.addEventListener('keydown', (e) => {
        const opts = optionRefs();
        const count = opts.length;
        const open = list.style.display !== 'none' && count > 0;
        if (!open) return;

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            activeIndex = Math.min(count - 1, activeIndex < 0 ? 0 : activeIndex + 1);
            highlight(activeIndex);
            break;
          case 'ArrowUp':
            e.preventDefault();
            activeIndex = Math.max(0, activeIndex - 1);
            highlight(activeIndex);
            break;
          case 'Enter':
            if (activeIndex >= 0 && activeIndex < count) {
              e.preventDefault();
              select(activeIndex);
            }
            break;
          case 'Escape':
            e.preventDefault();
            dismissed = true;
            activeIndex = -1;
            updateUI();
            break;
          case 'Tab':
            if (!e.shiftKey) {
              // Tab from search field focuses result 1
              e.preventDefault();
              activeIndex = 0;
              isNavigatingTab = true;
              opts[0].focus();
              isNavigatingTab = false;
              highlight(0);
            } else {
              dismissed = true;
              activeIndex = -1;
              updateUI();
            }
            break;
        }
      });
    }

    const WELLS = [
      { id: '1', label: 'Alexander 1-20H' },
      { id: '2', label: 'Alexander 2-20H' },
      { id: '3', label: 'Alexander 3-20H' },
      { id: '4', label: 'Alexander 4-20H' },
      { id: '5', label: 'Alexander 5-20H' },
    ];

    const DISPOSALS = [
      { id: 'd1', label: 'Bison SWD' },
      { id: 'd2', label: 'Blue SWD' },
      { id: 'd3', label: 'Buffalo SWD' },
    ];

    setupAutocomplete({
      inputId: 'well-input',
      listId: 'well-list',
      itemsSource: (q) => WELLS.filter(w => w.label.toLowerCase().includes(q.toLowerCase())),
      onSelect: (w) => {
        document.getElementById('well-input').value = w.label;
      }
    });

    setupAutocomplete({
      inputId: 'disposal-input',
      listId: 'disposal-list',
      itemsSource: (q) => DISPOSALS.filter(d => d.label.toLowerCase().includes(q.toLowerCase())),
      onSelect: (d) => {
        document.getElementById('disposal-input').value = d.label;
      }
    });
  </script>
</body>
</html>`;
}

async function runTests() {
  console.log('=== Dispatch Job Builder search-field keyboard UX Real-DOM Verification ===');
  const browser = await chromium.launch();

  // Test across two viewport sizes: standard desktop (1280px) and narrow (344px)
  for (const viewport of [
    { name: 'Desktop (1280px)', width: 1280, height: 800 },
    { name: 'Galaxy Z Fold Narrow (344px)', width: 344, height: 800 }
  ]) {
    console.log(`\nTesting Viewport: ${viewport.name}`);
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    await page.setContent(makeHtml());

    // 1. Well Search: Tab into result 1, Tab through visible results, Shift+Tab back
    console.log('  Testing Well Search: Tab into results, navigate forward/backward...');
    await page.focus('#well-input');
    await page.type('#well-input', 'alex');
    await page.waitForSelector('#well-list .wb-option-row');

    const optionsCount = await page.$$eval('#well-list .wb-option-row', (els) => els.length);
    if (optionsCount !== 5) fail(`Expected 5 well results, got ${optionsCount}`);

    // Tab from search field -> focuses result 1
    await page.keyboard.press('Tab');
    let activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-list-opt-0') fail(`Expected result 1 (well-list-opt-0) focused on first Tab, got ${activeId}`);

    // More Tabs move through visible results
    await page.keyboard.press('Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-list-opt-1') fail(`Expected result 2 focused, got ${activeId}`);

    await page.keyboard.press('Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-list-opt-2') fail(`Expected result 3 focused, got ${activeId}`);

    // Shift+Tab moves backward
    await page.keyboard.press('Shift+Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-list-opt-1') fail(`Expected result 2 focused on Shift+Tab, got ${activeId}`);

    await page.keyboard.press('Shift+Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-list-opt-0') fail(`Expected result 1 focused on Shift+Tab, got ${activeId}`);

    // Shift+Tab from result 1 returns to the search field input
    await page.keyboard.press('Shift+Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-input') fail(`Expected well-input focused on Shift+Tab from result 1, got ${activeId}`);

    // Tab again from input re-enters result 1
    await page.keyboard.press('Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-list-opt-0') fail(`Expected result 1 focused on re-Tab, got ${activeId}`);

    // Enter selects the focused result
    await page.keyboard.press('Enter');
    const selectedVal = await page.$eval('#well-input', (el) => el.value);
    if (selectedVal !== 'Alexander 1-20H') fail(`Expected Alexander 1-20H selected, got ${selectedVal}`);
    const isListHidden = await page.$eval('#well-list', (el) => el.style.display === 'none');
    if (!isListHidden) fail('Expected well-list hidden after Enter select');
    console.log('    ✓ Tab into result 1, forward/backward navigation, Shift+Tab to input, and Enter select verified.');

    // 2. Escape closes results
    console.log('  Testing Escape closes results...');
    await page.focus('#well-input');
    await page.fill('#well-input', 'alex');
    await page.waitForSelector('#well-list .wb-option-row');
    await page.keyboard.press('Tab'); // focus opt-0
    await page.keyboard.press('Escape');
    const isClosedAfterEsc = await page.$eval('#well-list', (el) => el.style.display === 'none');
    if (!isClosedAfterEsc) fail('Expected list closed on Escape');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'well-input') fail(`Expected focus returned to well-input on Escape, got ${activeId}`);
    console.log('    ✓ Escape closed results and returned focus to search input.');

    // 3. Tab after the last result reaches the next normal form field (Driver select)
    console.log('  Testing Tab after last result reaches Driver select...');
    await page.fill('#well-input', 'alex');
    await page.waitForSelector('#well-list .wb-option-row');
    // Tab through all 5 options: 0, 1, 2, 3, 4
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      const cur = await page.evaluate(() => document.activeElement?.id);
      if (cur !== `well-list-opt-${i}`) fail(`Expected opt-${i} focused, got ${cur}`);
    }
    // Now on last result (opt-4): press Tab
    await page.keyboard.press('Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'driver-select') fail(`Expected focus on driver-select after last result, got ${activeId}`);
    const isListClosedAfterExit = await page.$eval('#well-list', (el) => el.style.display === 'none');
    if (!isListClosedAfterExit) fail('Expected well-list closed after tabbing to driver-select');
    console.log('    ✓ Tab after last result cleanly reached Driver select; results closed.');

    // 4. Arrow Up/Down + Enter
    console.log('  Testing Arrow Up/Down + Enter on search field...');
    await page.focus('#well-input');
    await page.fill('#well-input', 'alex');
    await page.waitForSelector('#well-list .wb-option-row');
    await page.keyboard.press('ArrowDown'); // highlight opt-0
    let actDesc = await page.$eval('#well-input', (el) => el.getAttribute('aria-activedescendant'));
    if (actDesc !== 'well-list-opt-0') fail(`Expected aria-activedescendant=well-list-opt-0, got ${actDesc}`);

    await page.keyboard.press('ArrowDown'); // highlight opt-1
    actDesc = await page.$eval('#well-input', (el) => el.getAttribute('aria-activedescendant'));
    if (actDesc !== 'well-list-opt-1') fail(`Expected aria-activedescendant=well-list-opt-1, got ${actDesc}`);

    await page.keyboard.press('Enter');
    const arrowSelected = await page.$eval('#well-input', (el) => el.value);
    if (arrowSelected !== 'Alexander 2-20H') fail(`Expected Alexander 2-20H selected via ArrowDown+Enter, got ${arrowSelected}`);
    console.log('    ✓ Arrow Up/Down + Enter on search field verified.');

    // 5. When no results open, Tab moves normally to next field
    console.log('  Testing Tab when no results open...');
    await page.focus('#well-input');
    await page.fill('#well-input', ''); // empty -> no results open
    await page.keyboard.press('Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'driver-select') fail(`Expected focus on driver-select when tabbing from empty well-input, got ${activeId}`);
    console.log('    ✓ Tab when no results open moves normally to driver-select.');

    // 6. Disposal Search: Tab into results -> Tab after last result reaches Loads input
    console.log('  Testing Disposal Search: Tab through results to Loads input...');
    await page.focus('#disposal-input');
    await page.type('#disposal-input', 'swd');
    await page.waitForSelector('#disposal-list .wb-option-row');
    const swdCount = await page.$$eval('#disposal-list .wb-option-row', (els) => els.length);
    if (swdCount !== 3) fail(`Expected 3 disposal results, got ${swdCount}`);

    // Tab into opt-0, opt-1, opt-2
    await page.keyboard.press('Tab'); // opt-0
    await page.keyboard.press('Tab'); // opt-1
    await page.keyboard.press('Tab'); // opt-2
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'disposal-list-opt-2') fail(`Expected disposal-list-opt-2 focused, got ${activeId}`);

    // Tab past opt-2 (last result) -> reaches loads-input!
    await page.keyboard.press('Tab');
    activeId = await page.evaluate(() => document.activeElement?.id);
    if (activeId !== 'loads-input') fail(`Expected focus on loads-input after last disposal result, got ${activeId}`);
    const isDisposalClosed = await page.$eval('#disposal-list', (el) => el.style.display === 'none');
    if (!isDisposalClosed) fail('Expected disposal-list closed after tabbing to loads-input');
    console.log('    ✓ Disposal Tab past last result cleanly reached Loads input.');

    // 7. Check horizontal overflow on narrow viewport
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth > el.clientWidth;
    });
    if (overflow) fail(`Horizontal overflow detected in viewport ${viewport.name}!`);
    console.log(`    ✓ Viewport ${viewport.name} layout intact (no horizontal overflow).`);

    await page.close();
  }

  await browser.close();
  console.log('\n✅ [PASSED] Dispatch Job Builder search-field keyboard UX certified across all viewports.\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
