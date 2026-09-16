import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextActiveIndex,
  reconcileActiveIndex,
  resetActiveIndex,
  scrollTopForOption,
  isOptionFullyVisible,
  isSelectableIndex,
  optionDomId,
} from '../autocompleteNavigation.ts';

// A list long enough to OVERFLOW the container: 20 rows × 30px = 600px content in a
// 128px viewport (~4 rows visible) — the exact condition where a naive highlight
// scrolls out of view.
const COUNT = 20;
const ROW = 30;
const VIEWPORT = 128;
const opt = (i: number) => ({ offsetTop: i * ROW, offsetHeight: ROW });

test('ArrowDown from empty highlights the first row; ArrowUp from empty also highlights first', () => {
  assert.equal(nextActiveIndex(-1, COUNT, 1), 0);
  assert.equal(nextActiveIndex(-1, COUNT, -1), 0);
});

test('repeatedly pressing ArrowDown keeps EVERY highlighted row fully within the viewport', () => {
  let active = -1;
  let scrollTop = 0;
  for (let step = 0; step < COUNT + 5; step++) {
    active = nextActiveIndex(active, COUNT, 1);
    scrollTop = scrollTopForOption({ scrollTop, clientHeight: VIEWPORT }, opt(active));
    assert.ok(
      isOptionFullyVisible({ scrollTop, clientHeight: VIEWPORT }, opt(active)),
      `row ${active} must be fully visible after ArrowDown (scrollTop=${scrollTop})`,
    );
  }
  assert.equal(active, COUNT - 1, 'ArrowDown clamps at the last row (no wrap jump)');
});

test('ArrowUp back toward the top keeps EVERY highlighted row fully within the viewport', () => {
  // Start at the bottom, fully scrolled.
  let active = COUNT - 1;
  let scrollTop = scrollTopForOption({ scrollTop: 0, clientHeight: VIEWPORT }, opt(active));
  for (let step = 0; step < COUNT + 5; step++) {
    active = nextActiveIndex(active, COUNT, -1);
    scrollTop = scrollTopForOption({ scrollTop, clientHeight: VIEWPORT }, opt(active));
    assert.ok(
      isOptionFullyVisible({ scrollTop, clientHeight: VIEWPORT }, opt(active)),
      `row ${active} must be fully visible after ArrowUp (scrollTop=${scrollTop})`,
    );
  }
  assert.equal(active, 0, 'ArrowUp clamps at the first row');
});

test('only the CONTAINER scroll changes — the function returns a container scrollTop, nothing global', () => {
  // Moving down the list changes the returned scrollTop monotonically; there is no
  // window/page dimension in the contract at all.
  let scrollTop = 0;
  const seen: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    scrollTop = scrollTopForOption({ scrollTop, clientHeight: VIEWPORT }, opt(i));
    seen.push(scrollTop);
  }
  // Early rows need no scroll; later rows scroll the container down; max is bounded
  // by content-minus-viewport (never arbitrary page scroll).
  assert.equal(seen[0], 0, 'first row needs no scroll');
  assert.equal(seen[COUNT - 1], COUNT * ROW - VIEWPORT, 'last row aligns its bottom edge');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'container scroll is monotonic downward');
});

test('nearest-edge: an already-visible option does NOT move the scroll', () => {
  // Viewport shows rows 0..4 (0..150px). Row 2 (60..90) is fully visible → no change.
  assert.equal(scrollTopForOption({ scrollTop: 0, clientHeight: VIEWPORT }, opt(2)), 0);
});

test('a changed query / reopen resets to NO active option (never a stale/invisible highlight)', () => {
  assert.equal(resetActiveIndex(), -1);
});

test('defensive reconcile clamps an in-place shrink and drops an off-the-end highlight', () => {
  assert.equal(reconcileActiveIndex(12, 0), -1, 'no results → none');
  assert.equal(reconcileActiveIndex(2, 5), 2, 'still-valid highlight kept');
  assert.equal(reconcileActiveIndex(12, 5), 4, 'off-the-end highlight clamps to last');
  assert.equal(reconcileActiveIndex(-1, 5), -1, 'none stays none');
});

test('empty / loading / no-result rows are never keyboard-selectable', () => {
  assert.equal(isSelectableIndex(0, 0), false);
  assert.equal(isSelectableIndex(-1, 5), false);
  assert.equal(isSelectableIndex(5, 5), false);
  assert.equal(isSelectableIndex(4, 5), true);
});

test('option DOM ids are stable and unique per index (for aria-activedescendant)', () => {
  assert.equal(optionDomId('pw-well', 3), 'pw-well-opt-3');
  assert.notEqual(optionDomId('pw-well', 3), optionDomId('pw-well', 4));
});
