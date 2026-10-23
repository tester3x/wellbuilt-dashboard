const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkRelease, FLOOR_REF, acquireLock, releaseLock } = require('../scripts/hosting-release-state.cjs');
const { verifyExport } = require('../scripts/deploy-hosting.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-release-test-'));
function run(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const remote = path.join(root, 'remote.git'), repo = path.join(root, 'repo');
fs.mkdirSync(remote); run(remote, 'init', '--bare'); fs.mkdirSync(repo); run(repo, 'init');
run(repo, 'config', 'user.name', 'Release Test'); run(repo, 'config', 'user.email', 'fixture@example.invalid');
run(repo, 'checkout', '-b', 'release/dashboard-fixture'); run(repo, 'remote', 'add', 'origin', remote);
function commit(value) { fs.writeFileSync(path.join(repo, 'fixture'), value); run(repo, 'add', 'fixture'); run(repo, 'commit', '-m', value); return run(repo, 'rev-parse', 'HEAD'); }
const base = commit('base'); run(repo, 'push', 'origin', `HEAD:${FLOOR_REF}`, 'HEAD:refs/heads/release/dashboard-fixture');
assert.equal(checkRelease(repo).floor, base);
const lock = acquireLock(base, repo);
assert.throws(() => acquireLock(base, repo), /shared Hosting lock/);
assert.throws(() => releaseLock('wrong-owner', repo), /ownership/);
releaseLock(lock, repo);
releaseLock(acquireLock(base, repo), repo);
const next = commit('new fix'); assert.throws(() => checkRelease(repo), /exactly match/);
run(repo, 'push', 'origin', 'HEAD:refs/heads/release/dashboard-fixture'); assert.equal(checkRelease(repo).source, next);
run(repo, 'push', 'origin', `HEAD:${FLOOR_REF}`);
run(repo, 'checkout', '-b', 'release/dashboard-stale', base); run(repo, 'push', 'origin', 'HEAD:refs/heads/release/dashboard-stale');
assert.throws(() => checkRelease(repo), /Stale release/);
commit('sibling fix'); run(repo, 'push', 'origin', 'HEAD:refs/heads/release/dashboard-stale'); assert.throws(() => checkRelease(repo), /Stale release/);
run(repo, 'checkout', 'release/dashboard-fixture'); fs.writeFileSync(path.join(repo, 'untracked'), 'dirty');
assert.throws(() => checkRelease(repo), /clean/); fs.unlinkSync(path.join(repo, 'untracked'));
run(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git')); assert.throws(() => checkRelease(repo));
(async () => {
  const output = path.join(root, 'out'); fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'index.html'), 'page'); fs.writeFileSync(path.join(output, 'image.png'), Buffer.from([0, 1, 2]));
  const request = async url => new Response(fs.readFileSync(path.join(output, url.endsWith('/') ? 'index.html' : 'image.png')));
  assert.equal((await verifyExport(output, 'https://fixture.invalid', request)).length, 2);
  await assert.rejects(verifyExport(output, 'https://fixture.invalid', async () => new Response('stale')), /mismatch/);
  await assert.rejects(verifyExport(output, 'https://fixture.invalid', async () => new Response('', { status: 404 })), /HTTP 404/);
  console.log('Release guards passed: current, unpushed, old, divergent, dirty, unreachable origin; shared lock contention/ownership; complete live bytes, mismatch and HTTP failure.');
  // Leave the tiny isolated fixture outside the repository; no recursive removal.
})().catch(error => { console.error(error); process.exitCode = 1; });
