/**
 * Dashboard Add Well submit: parse, duplicate, error display, click guard.
 * Run: node --experimental-strip-types tools/test-addWellSubmit.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KAHUNA_2_ATTEMPT,
  applyAddWellSuccess,
  buildAddWellConfig,
  classifyAddWellError,
  createAddWellClickGuard,
  decideAddWellSubmit,
  feetToDisplay,
  parseLevelToFeet,
  rebuildRoutesFromConfigs,
} from '../src/lib/addWellSubmit.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

{
  const built = buildAddWellConfig(KAHUNA_2_ATTEMPT);
  check('Kahuna 2 linked NDIC payload builds', built.ok === true);
  if (built.ok) {
    check('preserves driver-facing name Kahuna 2', built.wellName === 'Kahuna 2');
    check('preserves NDIC name Kahuna 2-6-7H', built.config.ndicName === 'Kahuna 2-6-7H');
    check('preserves API 33-053-10170-00-00', built.config.ndicApiNo === '33-053-10170-00-00');
    check('does not use Kahuna 1 API', built.config.ndicApiNo !== '33-053-03504-00-00');
    check('route Kahuna 381', built.config.route === 'Kahuna 381');
    check('bottom 1.3 decimal feet', built.config.bottomLevel === 1.3);
    check('six tanks', built.config.tanks === 6 && built.config.numTanks === 6);
    check('provisional 500 BBL / 20 ft → 150 BBL/ft', built.config.tankCapacity === 500 && built.config.tankHeight === 20 && built.config.bblPerFoot === 150);
    check('pull 140 / water 9.7 / H2S none', built.config.pullBbls === 140 && built.config.waterWeight === 9.7 && built.config.h2sStatus === 'none');
  }
}

check('1.3 bottom parses to 1.3 ft', parseLevelToFeet('1.3') === 1.3);
check('1.3 displays as approximately 1\'4"', feetToDisplay(parseLevelToFeet('1.3')) === '1\'4"');
check('1\'4" parses to 1 + 4/12', Math.abs(parseLevelToFeet('1\'4"') - (1 + 4 / 12)) < 1e-9);
check('empty bottom is 0, not silently 3', parseLevelToFeet('') === 0);

{
  const existingKahuna1 = {
    'Kahuna 1': { ndicApiNo: '33-053-03504-00-00' },
  };
  const ok = decideAddWellSubmit(KAHUNA_2_ATTEMPT, existingKahuna1);
  check('submit allowed when Kahuna 1 exists with a different API', ok.action === 'submit');

  const dupName = decideAddWellSubmit(KAHUNA_2_ATTEMPT, {
    'Kahuna 2': { ndicApiNo: '33-053-10170-00-00' },
  });
  check('same name + same API is idempotent retry (still submits)', dupName.action === 'submit');

  const clash = decideAddWellSubmit(KAHUNA_2_ATTEMPT, {
    'Kahuna 2': { ndicApiNo: '33-053-03504-00-00' },
  });
  check('same name + different API is rejected', clash.action === 'reject' && clash.reason === 'duplicate_name');

  const dupApi = decideAddWellSubmit(KAHUNA_2_ATTEMPT, {
    'Other': { ndicApiNo: '33-053-10170-00-00' },
  });
  check('duplicate API on another well is rejected', dupApi.action === 'reject' && dupApi.reason === 'duplicate_api');
}

{
  const authz = classifyAddWellError({ code: 'functions/permission-denied', message: 'Caller lacks manageDrivers capability' });
  check('authorization failure is shown to the user', authz.reason === 'permission-denied' && /not authorized/i.test(authz.message));
  const net = classifyAddWellError({ code: 'functions/unavailable', message: 'network' });
  check('backend/network failure is shown to the user', net.reason === 'unavailable' && /server/i.test(net.message));
  const missing = classifyAddWellError({ code: 'functions/not-found', message: 'NOT FOUND' });
  check('missing callable is a specific error, not silence', missing.reason === 'missing-callable' && missing.message.length > 0);
}

{
  const guard = createAddWellClickGuard();
  check('first click begins', guard.tryBegin() === true);
  check('double-click is ignored', guard.tryBegin() === false);
  guard.end();
  check('after completion a new click begins', guard.tryBegin() === true);
}

{
  const next = applyAddWellSuccess({}, 'Kahuna 2', buildAddWellConfig(KAHUNA_2_ATTEMPT).config);
  check('successful response inserts Kahuna 2 into the list', !!next['Kahuna 2']);
  const rebuilt = rebuildRoutesFromConfigs(next);
  check('list refresh includes Kahuna 381', rebuilt.routes.includes('Kahuna 381') && rebuilt.routeWells['Kahuna 381'].includes('Kahuna 2'));
}

{
  const page = src('src/app/admin/page.tsx');
  const adapter = src('src/lib/staffWriteWellConfig.ts');
  const add = page.slice(page.indexOf('const handleAddWell'), page.indexOf('const handleUpdateWell'));
  check('page uses production staffCreateWellConfig adapter', add.includes('staffCreateWellConfig'));
  check('adapter calls staffWriteWellConfig', adapter.includes("'staffWriteWellConfig'"));
  check('Add Well no longer silently set()s well_config', !/set\(ref\(db,\s*`well_config/.test(add));
  check('submitting progress is rendered', page.includes("Creating “{addWellStatus.wellName}”") || page.includes('Adding Well'));
  check('errors stay on the Add Well card', page.includes("addWellStatus.kind === 'error'"));
  check('success stays on the Add Well card', page.includes("addWellStatus.kind === 'success'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
