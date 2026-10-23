import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProfileAuth} from './profile-auth.mjs';

test('WhatsApp logout preserves the live profile without suppressing auth lifecycle', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'watchdog-profile-auth-'));
  try {
    const file = path.join(directory, 'profile-marker');
    writeFileSync(file, 'keep');
    let notified = 0;
    class LocalAuth {
      constructor(options) { this.options = options; this.authenticated = false; }
      async logout() { throw new Error('EBUSY: live Chromium profile'); }
      async beforeBrowserInitialized() { this.before = true; }
      async afterBrowserInitialized() { this.after = true; }
    }
    const auth = createProfileAuth(LocalAuth, {dataPath: directory}, () => notified++);
    await auth.logout();
    await auth.beforeBrowserInitialized();
    await auth.afterBrowserInitialized();
    assert.equal(readFileSync(file, 'utf8'), 'keep');
    assert.equal(auth.options.dataPath, directory);
    assert.equal(notified, 1);
    assert.equal(auth.authenticated, false);
    assert.equal(auth.before, true);
    assert.equal(auth.after, true);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
