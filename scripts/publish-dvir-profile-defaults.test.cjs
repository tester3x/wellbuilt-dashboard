const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const equipment = process.env.WB_EQUIPMENT_SOURCE;
const script = path.join(__dirname, 'publish-dvir-profile-defaults.cjs');
function run(args) {
  return spawnSync(process.execPath, [script, equipment || '', ...args], {
    encoding: 'utf8', env: {...process.env, WB_DVIR_PROFILE_PUBLISH: '1', GOOGLE_CLOUD_PROJECT: 'wellbuilt-sync'},
  });
}
test('publication cannot affect both defaults through an implicit selection', () => {
  const result = run(['--publish']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /one explicit --profile/);
});
test('unrecognized profile cannot reach a publish operation', () => {
  const result = run(['--profile', 'wrong', '--publish', '--approved-revision', 'r1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown default profile/);
});
test('selective dry run validates hot-oiler media without including water-hauler', {skip: !equipment}, () => {
  const result = run(['--profile', 'hot-oiler-v1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN hot-oiler-v1: 9 areas, 9 matching media hashes/);
  assert.doesNotMatch(result.stdout, /tractor-tanker/);
});
test('a different approved revision fails before credentials or remote writes', {skip: !equipment}, () => {
  const result = run(['--profile', 'hot-oiler-v1', '--publish', '--approved-revision', 'unreviewed']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Approval does not match/);
});
