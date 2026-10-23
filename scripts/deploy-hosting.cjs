const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { checkRelease, git, FLOOR_REF, LOCK_REF, releaseLock } = require('./hosting-release-state.cjs');
async function verifyExport(root, base, request = fetch) {
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile()).map(item => path.relative(root, path.join(item.parentPath || item.path, item.name)).replaceAll('\\', '/'))
    .filter(file => !file.split('/').some(part => part.startsWith('.')));
  if (!files.includes('index.html')) throw Error('Missing exported index.html.');
  let cursor = 0; const results = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const url = '/' + file.replace(/index\.html$/, '').split('/').map(encodeURIComponent).join('/');
      const response = await request(base + url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error(`Live verification failed: ${file} HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!fs.readFileSync(path.join(root, file)).equals(bytes)) throw Error(`Live byte mismatch: ${file}`);
      results.push({ file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }));
  return results.sort((a, b) => a.file.localeCompare(b.file));
}
async function deploy() {
  const state = checkRelease();
  // The Firebase predeploy hook does the clean build and all required checks.
  execFileSync(process.platform === 'win32' ? 'firebase.cmd' : 'firebase',
    ['deploy', '--only', 'hosting', '--project', 'wellbuilt-sync', '--non-interactive', '-m', `Dashboard source ${state.source}`],
    { stdio: 'inherit', shell: process.platform === 'win32' });
}
async function finalize() {
  const state = JSON.parse(fs.readFileSync('.firebase/hosting-preflight.json', 'utf8'));
  if (git(['rev-parse', 'HEAD']) !== state.source || git(['status', '--porcelain'])) throw Error('Source changed during release; approved checkpoint was not advanced.');
  // Re-fetch after deploy too; do not silently advance past a concurrent release.
  const current = checkRelease();
  if (current.floor !== state.floor) throw Error('Approved checkpoint changed during deployment; verify concurrent release before proceeding.');
  if (!state.lock || git(['ls-remote', 'origin', LOCK_REF]).split(/\s/)[0] !== state.lock) throw Error('Missing shared Hosting lock.');
  const files = await verifyExport(path.resolve('out'), 'https://wellbuilt-sync.web.app');
  const record = { ...state, verifiedAt: new Date().toISOString(), files };
  fs.mkdirSync('.firebase', { recursive: true });
  fs.writeFileSync('.firebase/verified-hosting-release.json', JSON.stringify(record, null, 2));
  // Normal fast-forward push only: never overwrite a newer release checkpoint.
  git(['push', 'origin', `${state.source}:${FLOOR_REF}`]);
  releaseLock(state.lock);
  console.log(`Verified ${files.length} live artifacts; approved checkpoint advanced to ${state.source}.`);
}
module.exports = { verifyExport, finalize };
if (require.main === module) (process.argv[2] === '--verify' ? finalize() : deploy()).catch(error => { console.error(error.message); process.exitCode = 1; });
