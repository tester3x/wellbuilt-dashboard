const { execFileSync } = require('node:child_process');
const FLOOR_REF = 'refs/heads/release/dashboard-approved-base';
const LOCK_REF = 'refs/heads/release/dashboard-hosting-lock';
function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function checkRelease(cwd = process.cwd()) {
  const branch = git(['branch', '--show-current'], cwd);
  if (!/^release\/dashboard-/.test(branch) || branch === 'release/dashboard-approved-base') throw Error('Use a Dashboard release branch; the approved-base branch is not a working branch.');
  if (git(['status', '--porcelain'], cwd)) throw Error('Release checkout must be clean.');
  const source = git(['rev-parse', 'HEAD'], cwd);
  // Fetch exact refs every time. Network errors or missing refs must stop release.
  git(['fetch', '--no-tags', 'origin', FLOOR_REF], cwd);
  const floor = git(['rev-parse', 'FETCH_HEAD'], cwd);
  try { git(['merge-base', '--is-ancestor', floor, source], cwd); }
  catch { throw Error(`Stale release: merge approved Dashboard checkpoint ${floor} before deploying.`); }
  git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`], cwd);
  if (git(['rev-parse', 'FETCH_HEAD'], cwd) !== source) throw Error('Release HEAD must exactly match its pushed origin branch.');
  return { branch, source, floor };
}
function acquireLock(source, cwd = process.cwd()) {
  const tree = git(['rev-parse', `${source}^{tree}`], cwd);
  // An orphan commit cannot fast-forward an existing lock, even for the same HEAD.
  const lock = git(['commit-tree', tree, '-m', `Hosting release ${source} ${require('node:crypto').randomUUID()}`], cwd);
  try { git(['push', 'origin', `${lock}:${LOCK_REF}`], cwd); }
  catch { throw Error('Could not acquire shared Hosting lock. Another release or an unfinished deployment requires investigation.'); }
  return lock;
}
function releaseLock(lock, cwd = process.cwd()) {
  const current = git(['ls-remote', 'origin', LOCK_REF], cwd).split(/\s/)[0];
  if (current !== lock) throw Error('Hosting lock ownership changed; refusing cleanup.');
  git(['push', 'origin', '--delete', LOCK_REF], cwd);
}
module.exports = { FLOOR_REF, LOCK_REF, git, checkRelease, acquireLock, releaseLock };
if (require.main === module) {
  try { console.log(JSON.stringify(checkRelease())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
