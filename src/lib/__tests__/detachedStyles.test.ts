import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyStyles } from '../../components/detachedStyles';

test('detached pane uses loaded CSS when its original asset URL is gone', () => {
  const originalObserver = globalThis.MutationObserver;
  class Observer {
    observe() {}
    disconnect() {}
  }
  globalThis.MutationObserver = Observer as unknown as typeof MutationObserver;
  try {
    const appended: Array<{ tag: string; textContent: string; href?: string; remove: () => void }> = [];
    const oldLink = {
      sheet: { cssRules: [{ cssText: '.well-queue { background: rgb(17, 24, 39); }' }] },
      href: 'https://example.test/_next/static/css/deleted-after-deploy.css',
    };
    const source = {
      querySelectorAll: () => [oldLink],
      head: {},
      documentElement: { className: 'dark' },
      body: { className: 'app' },
    };
    const destination = {
      head: {
        querySelectorAll: () => appended,
        appendChild: (node: (typeof appended)[number]) => appended.push(node),
      },
      createElement: (tag: string) => ({
        tag, textContent: '', setAttribute() {}, remove() {},
      }),
      documentElement: { className: '' },
      body: { className: '' },
    };
    const stop = copyStyles(source as unknown as Document, destination as unknown as Document);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].tag, 'style');
    assert.match(appended[0].textContent, /well-queue/);
    assert.equal(destination.documentElement.className, 'dark');
    stop();
  } finally {
    globalThis.MutationObserver = originalObserver;
  }
});
