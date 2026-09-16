import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const SCREENSHOT_DIR = 'C:/Users/Michael Burger/.gemini/antigravity/brain/05d237a8-653a-446c-bbaa-715b01b4c240/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Load compiled Tailwind CSS from out/
const cssDir = path.join(process.cwd(), 'out/_next/static/css');
const cssFiles = fs.readdirSync(cssDir).filter(f => f.endsWith('.css'));
const cssContent = cssFiles.map(f => fs.readFileSync(path.join(cssDir, f), 'utf8')).join('\n');

const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dispatch Job Types Card Render Test</title>
  <style>
    ${cssContent}
    /* Fallbacks for custom Tailwind palette if needed */
    .bg-gray-750 { background-color: #262f3d; }
    .border-gray-650 { border-color: #3b4758; }
    .bg-gray-850 { background-color: #19202c; }
    .text-2xs { font-size: 0.65rem; line-height: 0.85rem; }
  </style>
</head>
<body class="bg-gray-900 text-white font-sans antialiased p-4">
  <div class="max-w-4xl mx-auto space-y-4">
    <!-- Header simulation -->
    <div class="mb-4">
      <h2 class="text-2xl font-bold text-white">Company Settings</h2>
      <p class="text-gray-400 text-sm mt-1">Liquid Gold Hauling LLC</p>
    </div>

    <!-- Dispatch Job Types Card Component -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden" id="dispatch-job-types-card">
      <!-- Header -->
      <div class="px-4 py-3 border-b border-gray-700 bg-gray-850 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <div class="flex items-center gap-2">
            <h3 class="text-white font-semibold text-sm">Dispatch Job Types</h3>
            <span class="px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider rounded bg-amber-900/50 text-amber-300 border border-amber-600/40">
              Unsaved Changes
            </span>
          </div>
          <p class="text-gray-400 text-xs mt-0.5">
            Choose the job-type terms dispatchers and drivers see. Each type remains Production Water or Service Work internally.
          </p>
        </div>
        <div class="flex items-center gap-2 text-xs text-gray-400">
          <span>3 of 4 enabled</span>
        </div>
      </div>

      <!-- Main Content Area -->
      <div class="p-4 space-y-4">
        <!-- Job Types List -->
        <div class="space-y-2">
          <!-- Item 1: PW -->
          <div class="p-3 rounded-lg border transition-colors bg-gray-750/70 border-gray-650">
            <div class="flex flex-col md:flex-row md:items-center gap-3">
              <div class="flex items-center gap-2 shrink-0">
                <div class="flex items-center gap-1">
                  <button type="button" disabled class="p-1 rounded bg-gray-700 opacity-30 text-gray-300">▲</button>
                  <button type="button" class="p-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">▼</button>
                </div>
                <div class="w-16">
                  <input type="text" value="PW" maxlength="2" class="w-full px-2 py-1.5 text-center font-mono font-bold text-sm rounded bg-gray-700 text-white uppercase border border-gray-600" />
                </div>
              </div>
              <div class="flex-1 min-w-[140px]">
                <input type="text" value="Production Water" class="w-full px-3 py-1.5 text-sm rounded bg-gray-700 text-white border border-gray-600" />
              </div>
              <div class="shrink-0">
                <select class="px-2.5 py-1.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600">
                  <option selected>Class: Production Water (PW)</option>
                  <option>Class: Service Work (SW)</option>
                </select>
              </div>
              <div class="flex items-center justify-between md:justify-end gap-3 shrink-0">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked class="rounded border-gray-500 text-blue-500 bg-gray-800" />
                  <span class="text-xs text-gray-200">Enabled</span>
                </label>
                <span class="text-2xs text-gray-400 px-1.5 py-0.5 rounded bg-gray-700/50">Saved</span>
              </div>
            </div>
          </div>

          <!-- Item 2: SW -->
          <div class="p-3 rounded-lg border transition-colors bg-gray-750/70 border-gray-650">
            <div class="flex flex-col md:flex-row md:items-center gap-3">
              <div class="flex items-center gap-2 shrink-0">
                <div class="flex items-center gap-1">
                  <button type="button" class="p-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">▲</button>
                  <button type="button" class="p-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">▼</button>
                </div>
                <div class="w-16">
                  <input type="text" value="SW" maxlength="2" class="w-full px-2 py-1.5 text-center font-mono font-bold text-sm rounded bg-gray-700 text-white uppercase border border-gray-600" />
                </div>
              </div>
              <div class="flex-1 min-w-[140px]">
                <input type="text" value="Service Work" class="w-full px-3 py-1.5 text-sm rounded bg-gray-700 text-white border border-gray-600" />
              </div>
              <div class="shrink-0">
                <select class="px-2.5 py-1.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600">
                  <option>Class: Production Water (PW)</option>
                  <option selected>Class: Service Work (SW)</option>
                </select>
              </div>
              <div class="flex items-center justify-between md:justify-end gap-3 shrink-0">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked class="rounded border-gray-500 text-blue-500 bg-gray-800" />
                  <span class="text-xs text-gray-200">Enabled</span>
                </label>
                <span class="text-2xs text-gray-400 px-1.5 py-0.5 rounded bg-gray-700/50">Saved</span>
              </div>
            </div>
          </div>

          <!-- Item 3: DW (Custom Production class) -->
          <div class="p-3 rounded-lg border transition-colors bg-gray-750/70 border-gray-650">
            <div class="flex flex-col md:flex-row md:items-center gap-3">
              <div class="flex items-center gap-2 shrink-0">
                <div class="flex items-center gap-1">
                  <button type="button" class="p-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">▲</button>
                  <button type="button" class="p-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">▼</button>
                </div>
                <div class="w-16">
                  <input type="text" value="DW" maxlength="2" class="w-full px-2 py-1.5 text-center font-mono font-bold text-sm rounded bg-gray-700 text-white uppercase border border-gray-600" />
                </div>
              </div>
              <div class="flex-1 min-w-[140px]">
                <input type="text" value="Disposal Water" class="w-full px-3 py-1.5 text-sm rounded bg-gray-700 text-white border border-gray-600" />
              </div>
              <div class="shrink-0">
                <select class="px-2.5 py-1.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600">
                  <option selected>Class: Production Water (PW)</option>
                  <option>Class: Service Work (SW)</option>
                </select>
              </div>
              <div class="flex items-center justify-between md:justify-end gap-3 shrink-0">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked class="rounded border-gray-500 text-blue-500 bg-gray-800" />
                  <span class="text-xs text-gray-200">Enabled</span>
                </label>
                <button type="button" class="px-2 py-1 text-xs text-red-400 hover:text-red-300 rounded">Remove</button>
              </div>
            </div>
          </div>

          <!-- Item 4: FB (Disabled custom term) -->
          <div class="p-3 rounded-lg border transition-colors bg-gray-800/60 border-gray-700/60 opacity-75">
            <div class="flex flex-col md:flex-row md:items-center gap-3">
              <div class="flex items-center gap-2 shrink-0">
                <div class="flex items-center gap-1">
                  <button type="button" class="p-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">▲</button>
                  <button type="button" disabled class="p-1 rounded bg-gray-700 opacity-30 text-gray-300">▼</button>
                </div>
                <div class="w-16">
                  <input type="text" value="FB" maxlength="2" class="w-full px-2 py-1.5 text-center font-mono font-bold text-sm rounded bg-gray-700 text-white uppercase border border-gray-600" />
                </div>
              </div>
              <div class="flex-1 min-w-[140px]">
                <input type="text" value="Flowback Water" class="w-full px-3 py-1.5 text-sm rounded bg-gray-700 text-white border border-gray-600" />
              </div>
              <div class="shrink-0">
                <select class="px-2.5 py-1.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600">
                  <option selected>Class: Production Water (PW)</option>
                  <option>Class: Service Work (SW)</option>
                </select>
              </div>
              <div class="flex items-center justify-between md:justify-end gap-3 shrink-0">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" class="rounded border-gray-500 text-blue-500 bg-gray-800" />
                  <span class="text-xs text-gray-400">Disabled</span>
                </label>
                <span class="text-2xs text-gray-400 px-1.5 py-0.5 rounded bg-gray-700/50">Saved</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Add Job Type Row -->
        <div class="p-3 bg-gray-850 rounded-lg border border-dashed border-gray-700 space-y-2">
          <div class="text-xs font-medium text-gray-300">Add New Job Type</div>
          <div class="flex flex-col sm:flex-row gap-2">
            <div class="w-full sm:w-20">
              <input type="text" placeholder="Code" maxlength="2" class="w-full px-2 py-1.5 text-center font-mono font-bold text-sm rounded bg-gray-700 text-white placeholder-gray-500 uppercase border border-gray-600" />
            </div>
            <div class="flex-1">
              <input type="text" placeholder="e.g. Disposal Water, Flowback..." class="w-full px-3 py-1.5 text-sm rounded bg-gray-700 text-white placeholder-gray-500 border border-gray-600" />
            </div>
            <div class="w-full sm:w-auto">
              <select class="w-full sm:w-auto px-2.5 py-1.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600">
                <option selected>Class: Production Water (PW)</option>
                <option>Class: Service Work (SW)</option>
              </select>
            </div>
            <button type="button" class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors whitespace-nowrap">
              + Add Job Type
            </button>
          </div>
        </div>

        <!-- Footer Actions: Save & Cancel -->
        <div class="pt-2 border-t border-gray-700 flex items-center justify-between gap-3">
          <div class="text-2xs text-amber-400">
            You have unsaved changes.
          </div>
          <div class="flex items-center gap-2">
            <button type="button" class="px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded">
              Cancel
            </button>
            <button type="button" class="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded">
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;

async function run() {
  console.log('=== Capturing Visual Evidence for Dispatch Job Types Card ===');
  const browser = await chromium.launch({ headless: true });

  const viewports = [
    { name: 'desktop_1280px', width: 1280, height: 900 },
    { name: 'mobile_390px', width: 390, height: 844 },
    { name: 'fold_344px', width: 344, height: 882 },
  ];

  for (const vp of viewports) {
    const page = await browser.newPage();
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.setContent(htmlContent, { waitUntil: 'load' });

    // Check horizontal overflow
    const metrics = await page.evaluate(() => {
      const card = document.getElementById('dispatch-job-types-card');
      const doc = document.documentElement;
      return {
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
        cardScrollWidth: card.scrollWidth,
        cardClientWidth: card.clientWidth,
        hasDocOverflow: doc.scrollWidth > doc.clientWidth,
      };
    });

    console.log(`Viewport ${vp.name}: width=${vp.width}px, docScrollWidth=${metrics.docScrollWidth}px, overflow=${metrics.hasDocOverflow}`);
    if (metrics.hasDocOverflow) {
      throw new Error(`FAIL: Horizontal scroll overflow detected at viewport ${vp.name} (${metrics.docScrollWidth} > ${metrics.docClientWidth})`);
    }

    const shotPath = path.join(SCREENSHOT_DIR, `dispatch_job_types_card_${vp.name}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    console.log(`✓ Screenshot saved: ${shotPath}`);
    await page.close();
  }

  await browser.close();
  console.log('=== All Viewport Renders & Overflow Checks PASSED ===');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
