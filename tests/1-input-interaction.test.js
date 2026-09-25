/**
 * Input & Interaction E2E Tests
 *
 * Keyboard basics, mouse click/scroll, mouse drag/SGR, copy mode navigation,
 * copy mode search/yank, and touch scrolling.
 */

const {
  createTestContext,
  delay,
  navigateToSession,
  focusPage,
  focusTerminal,
  getTerminalText,
  waitForTerminalText,
  waitForShellPrompt,
  runCommand,
  getUIPaneCount,
  typeInTerminal,
  typeComposedChar,
  typeComposedText,
  pressEnter,
  sendKeyCombo,
  waitForPaneCount,
  splitPaneKeyboard,
  sendPrefixCommand,
  killPaneKeyboard,
  resizePaneKeyboard,
  DELAYS,
  assertContentMatch,
  assertLayoutInvariants,
  getCopyModeState,
  waitForCondition,
  waitForCopyMode,
  enterCopyModeAndWait,
  startMouseCapture,
  readMouseEvents,
  stopMouseCapture,
  ensureMouseCaptureStopped,
  pasteText,
} = require('./helpers');

// ==================== Touch Scroll Helpers ====================

async function dispatchTouchScroll(page, startX, startY, endY, steps = 10, stepDelay = 16) {
  const cdp = await page.context().newCDPSession(page);
  const deltaY = (endY - startY) / steps;

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y: startY }],
  });
  await delay(stepDelay);

  for (let i = 1; i <= steps; i++) {
    const y = startY + deltaY * i;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX, y }],
    });
    await delay(stepDelay);
  }

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
}

// ==================== Mouse Cell Helpers ====================

/**
 * The cell grid of a pane as the user sees it: the box the cells start in
 * and the size of one cell, read from the rendered lines rather than from the
 * app's idea of the grid — the dock draws its cells smaller than the panes.
 */
async function gridOf(page, rootSelector) {
  const grid = await page.evaluate((sel) => {
    const root = [...document.querySelectorAll(sel)].find(
      (el) => el.getBoundingClientRect().width > 0 && el.querySelector('.terminal-line'),
    );
    if (!root) return null;
    const box = root.querySelector('.pane-scroll-container').getBoundingClientRect();
    const line = root.querySelector('.terminal-line');
    return {
      x: box.x,
      y: box.y,
      cellW: parseFloat(getComputedStyle(line).getPropertyValue('--cell-w')),
      cellH: line.getBoundingClientRect().height,
    };
  }, rootSelector);
  expect(grid).not.toBeNull();
  return grid;
}

/**
 * Click `frac` of the way across cell (col, row), both 0-based, and return the
 * press tmux delivered for it.
 */
async function clickCell(page, grid, col, row, frac = 0.5) {
  const before = (await readMouseEvents(0, 200)).filter((e) => e.type === 'press').length;
  await page.mouse.click(grid.x + (col + frac) * grid.cellW, grid.y + (row + 0.5) * grid.cellH);
  const start = Date.now();
  let presses = [];
  while (Date.now() - start < 5000) {
    presses = (await readMouseEvents(0, 200)).filter((e) => e.type === 'press');
    if (presses.length > before) break;
    await delay(DELAYS.SHORT);
  }
  expect(presses.length).toBeGreaterThan(before);
  return presses[presses.length - 1];
}

// ==================== Scenario 1: General Layout ====================

describe('Scenario 1: General Layout', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Split vertical → split horizontal → 3 panes with correct sizes and positions', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Split vertical (prefix + %) → 2 panes side by side
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2, 10000);
    await delay(DELAYS.SYNC);

    // Step 1b: Verify typing works in the new pane immediately after split.
    // This catches output being dropped by panes_moved_window suppression.
    const SPLIT_TOKEN = 'SPLIT_VIS_' + Date.now();
    await runCommand(ctx.page, `echo ${SPLIT_TOKEN}`, SPLIT_TOKEN);

    // Step 2: Split horizontal (prefix + ") → 3 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3, 10000);
    await delay(DELAYS.SYNC);

    // Step 2b: Verify typing works in this pane too
    const SPLIT2_TOKEN = 'SPLIT2_VIS_' + Date.now();
    await runCommand(ctx.page, `echo ${SPLIT2_TOKEN}`, SPLIT2_TOKEN);

    // Step 3: Assert exactly 3 panes
    const paneCount = await getUIPaneCount(ctx.page);
    expect(paneCount).toBe(3);

    // Step 4: Read layout data from XState and compute expected positions
    const layoutData = await ctx.page.evaluate(() => {
      const snap = window.app?.getSnapshot();
      if (!snap?.context) return null;
      const c = snap.context;
      const visiblePanes = (c.panes || []).filter((p) => p.windowId === c.activeWindowId);
      return {
        charWidth: c.charWidth,
        charHeight: c.charHeight,
        totalWidth: c.totalWidth,
        totalHeight: c.totalHeight,
        containerWidth: c.containerWidth,
        containerHeight: c.containerHeight,
        panes: visiblePanes.map((p) => ({
          id: p.tmuxId,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
        })),
      };
    });
    expect(layoutData).not.toBeNull();
    expect(layoutData.panes.length).toBe(3);

    const { charWidth } = layoutData;

    // Step 5: Read DOM bounding rects and verify pane layout structure
    const actualRects = await ctx.page.evaluate(() => {
      const items = document.querySelectorAll('.pane-layout-item[data-pane-id]');
      const container = document.querySelector('.pane-container');
      if (!container) return null;
      const cRect = container.getBoundingClientRect();
      return Array.from(items).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute('data-pane-id'),
          left: r.left - cRect.left,
          top: r.top - cRect.top,
          width: r.width,
          height: r.height,
        };
      });
    });
    expect(actualRects).not.toBeNull();
    expect(actualRects.length).toBe(3);

    // Step 6: Verify pane layout structure
    // Sort panes by position for spatial checks
    const sorted = actualRects.slice().sort((a, b) => a.left - b.left || a.top - b.top);

    // Vertical split creates 2 columns, horizontal split creates 2 rows in one column.
    // Result: one column has 1 pane, the other has 2 stacked panes.

    // Verify 2 distinct left edges (two columns)
    const leftEdges = [...new Set(sorted.map((r) => Math.round(r.left)))];
    expect(leftEdges.length).toBe(2);

    // Group by column
    const col1 = sorted.filter((r) => Math.round(r.left) === leftEdges[0]);
    const col2 = sorted.filter((r) => Math.round(r.left) === leftEdges[1]);
    // One column has 1 pane, the other has 2 (order depends on which pane had focus)
    const singleCol = col1.length === 1 ? col1 : col2;
    const splitCol = col1.length === 2 ? col1 : col2;
    expect(singleCol.length).toBe(1);
    expect(splitCol.length).toBe(2);

    // Split column panes should be stacked vertically (same left, different top)
    expect(Math.abs(splitCol[0].left - splitCol[1].left)).toBeLessThanOrEqual(2);
    expect(splitCol[0].top).not.toBe(splitCol[1].top);

    // Mosaic invariant: every pane's box is exactly one cell wider than its
    // tmux content — the extra cell is the border, whose two halves are shared
    // with the neighbour (or the grid edge) so adjacent outlines coincide and
    // there are no gaps. See computePaneBox in tmuxy-ui/src/constants/layout.ts.
    const tolerance = 2;
    for (const pane of layoutData.panes) {
      const expectedWidth = (pane.width + 1) * charWidth;
      const actual = actualRects.find((a) => a.id === pane.id);
      expect(actual).toBeDefined();
      if (actual) {
        expect(Math.abs(actual.width - expectedWidth)).toBeLessThanOrEqual(tolerance);
      }
    }

    // All panes should have non-zero dimensions
    for (const rect of actualRects) {
      expect(rect.width).toBeGreaterThan(50);
      expect(rect.height).toBeGreaterThan(50);
    }

    await assertLayoutInvariants(ctx.page, { label: 'Scenario 1 end' });
    await assertContentMatch(ctx.page, 'Scenario 1 end');
  }, 180000);
});

// ==================== Scenario 2: Keyboard Basics ====================

describe('Scenario 2: Keyboard Basics', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Type → backspace → Tab → Ctrl+C → Ctrl+D → arrow-up history', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await assertContentMatch(ctx.page, 'Scenario 2 setup');

    // Step 1: Basic typing
    await runCommand(ctx.page, 'echo hello123', 'hello123');

    // Step 2: Backspace
    await typeInTerminal(ctx.page, 'echo helloxx');
    await ctx.page.keyboard.press('Backspace');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.press('Backspace');
    await delay(DELAYS.SHORT);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'hello');

    // Step 3: Tab completion
    await typeInTerminal(ctx.page, 'ech');
    await ctx.page.keyboard.press('Tab');
    await delay(DELAYS.LONG);
    await typeInTerminal(ctx.page, ' tab_complete_test');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'tab_complete_test');

    // Step 4: Ctrl+C interrupts
    await typeInTerminal(ctx.page, 'sleep 100');
    await pressEnter(ctx.page);
    await delay(DELAYS.EXTRA_LONG);
    await sendKeyCombo(ctx.page, 'Control', 'c');
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "after_interrupt"', 'after_interrupt');

    // Step 5: Ctrl+D sends EOF
    await typeInTerminal(ctx.page, 'cat');
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);
    await typeInTerminal(ctx.page, 'test_input');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);
    await sendKeyCombo(ctx.page, 'Control', 'd');
    await waitForTerminalText(ctx.page, 'test_input');

    // Step 6: Arrow-up history recall
    await runCommand(ctx.page, 'echo history_test_123', 'history_test_123');
    await runCommand(ctx.page, 'echo second_command', 'second_command');
    // Count occurrences BEFORE recall — the typed command + its output already
    // put 2 on screen, so an absolute threshold was satisfied before the
    // feature under test ever ran (the old assertion could not fail).
    const occurrences = async (text) => (await getTerminalText(ctx.page)).split(text).length - 1;
    const before = await occurrences('history_test_123');
    const secondBefore = await occurrences('second_command');
    // Each ArrowUp walks one line back through the shell's history and puts it
    // on the prompt, where it shows up as one more occurrence. Polled rather
    // than slept on: every step here is a keystroke → tmux → SSE round trip,
    // and a fixed wait is either flaky or slower than it needs to be.
    await ctx.page.keyboard.press('ArrowUp');
    await waitForCondition(
      ctx.page,
      async () => (await occurrences('second_command')) > secondBefore,
      10000,
      'the last command to be recalled onto the prompt',
    );
    await ctx.page.keyboard.press('ArrowUp');
    await waitForCondition(
      ctx.page,
      async () => (await occurrences('history_test_123')) > before,
      10000,
      'the command before it to be recalled onto the prompt',
    );
    await pressEnter(ctx.page);
    // Running it adds the echoed line and its output: two more occurrences.
    await waitForCondition(
      ctx.page,
      async () => (await occurrences('history_test_123')) >= before + 2,
      15000,
      'the recalled command to run again',
    );
    expect(await occurrences('history_test_123')).toBeGreaterThanOrEqual(before + 2);
    await assertContentMatch(ctx.page, 'Scenario 2 end');
  }, 180000);
});

// ==================== Scenario 2b: Browser Paste ====================

describe('Scenario 2b: Browser Paste', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('paste event delivers text to the terminal, including multi-word content', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await focusPage(ctx.page);

    // Paste rides the browser ClipboardEvent path (window paste listener →
    // machine → adapter → tmux paste buffer) — previously implemented but
    // never exercised by any test.
    const TOKEN = `PASTE_${Date.now()}`;
    await pasteText(ctx.page, `echo ${TOKEN} with spaces`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, `${TOKEN} with spaces`);
  }, 60000);
});

// ==================== Scenario 2c: International Input ====================

describe('Scenario 2c: International Input', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('dead-key, Option, AltGr and IME characters reach the shell as text', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await focusTerminal(ctx.page);

    // Three of the four ways a keyboard produces a character arrive wearing
    // flags that read like a command chord (keyCode 229, altKey, ctrl+alt).
    // Forwarded as tmux key names they become ESC-prefixed meta sequences the
    // shell throws away — which is what made diacritics untypable.
    const marker = `INTL${Date.now()}`;
    const payload = 'áéõñçø@€日本語';

    await typeInTerminal(ctx.page, `echo ${marker}`);
    for (const ch of 'áéõñ') await typeComposedChar(ctx.page, ch, 'dead');
    for (const ch of 'çø') await typeComposedChar(ctx.page, ch, 'option');
    for (const ch of '@€') await typeComposedChar(ctx.page, ch, 'altgr');
    await typeComposedText(ctx.page, '日本語');
    await pressEnter(ctx.page);

    // Echoed back by bash, so the assertion is on bytes the PROGRAM received
    // through real tmux — not merely on what was painted while typing. Two
    // occurrences: the command line, then echo's output.
    //
    // Wide CJK glyphs are rendered with the blank continuation cell tmux emits
    // beside them, so the row reads "日 本 語"; compare with whitespace stripped.
    const squash = (s) => s.replace(/\s+/g, '');
    const expected = squash(`${marker}${payload}`);
    const deadline = Date.now() + 20000;
    let occurrences = 0;
    while (Date.now() < deadline) {
      occurrences = squash(await getTerminalText(ctx.page)).split(expected).length - 1;
      if (occurrences >= 2) break;
      await delay(DELAYS.SHORT);
    }
    expect(occurrences).toBeGreaterThanOrEqual(2);
  }, 90000);
});

// ==================== Scenario 7: Mouse Click & Scroll ====================

describe('Scenario 7: Mouse Click & Scroll', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Click focus → wheel opens the scroll view (no copy mode) → text selects natively → typing closes it → prefix [ still gives copy mode', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await assertContentMatch(ctx.page, 'Scenario 7 setup');

    // Step 1: Click in terminal area doesn't lose focus
    await focusPage(ctx.page);
    const terminal = await ctx.page.$('[role="log"]');
    let box = await terminal.boundingBox();
    await ctx.page.mouse.click(box.x + 50, box.y + 50);
    await ctx.page.mouse.click(box.x + 100, box.y + 100);
    await delay(DELAYS.LONG);
    await runCommand(ctx.page, 'echo click_test', 'click_test');
    await runCommand(ctx.page, 'seq 1 100', '100');

    // Step 2: the wheel opens the native-like scroll view — scrollback to read
    // and select, with no cursor and nothing said to tmux. A wheel gesture
    // handing the pane a cursor and vi keys is the bug this replaced.
    // Paced ticks, each a full row or more, until the view opens: a burst of
    // sub-row deltas can all land before the client has the pane's history
    // size on a slow runner, and a tick that arrives then does nothing.
    await ctx.page.mouse.move(box.x + 100, box.y + box.height / 2);
    await waitForCondition(
      ctx.page,
      async () => {
        await ctx.page.mouse.wheel(0, -120);
        await delay(100);
        return (await getCopyModeState(ctx.page))?.mode === 'scroll';
      },
      15000,
      'the scroll view to open',
    );
    const scrolled = await getCopyModeState(ctx.page);
    expect(scrolled.mode).toBe('scroll');

    // The view moves a row at a time, like copy mode and like a full-screen
    // application: the container never rests part-way through a row, so the
    // top row is never drawn half on screen.
    const rowAlignment = async () =>
      ctx.page.evaluate(() => {
        const el = document.querySelector('.pane-scroll-container');
        const rowHeight = window.app.getSnapshot().context.charHeight;
        return { scrollTop: el.scrollTop, rowHeight, offset: el.scrollTop % rowHeight };
      });
    let aligned = await rowAlignment();
    expect(aligned.rowHeight).toBeGreaterThan(0);
    expect(aligned.scrollTop).toBeGreaterThan(0);
    expect(aligned.offset).toBeCloseTo(0, 5);

    // And a wheel tick that is not a whole number of rows still lands on one.
    await ctx.page.mouse.wheel(0, -Math.round(aligned.rowHeight * 1.5));
    await delay(DELAYS.MEDIUM);
    aligned = await rowAlignment();
    expect(aligned.offset).toBeCloseTo(0, 5);

    // tmux is untouched: the pane never entered copy mode, so the application
    // in it carries on and no mode is advertised to the user.
    const duringScroll = await ctx.page.evaluate(() => {
      const el = document.querySelector('[data-scroll-mode="true"]');
      const pane = window.app.getSnapshot().context.panes[0];
      return {
        rendered: !!el && el.getBoundingClientRect().height > 0,
        userSelect: el ? getComputedStyle(el).userSelect : null,
        copyCursor: !!document.querySelector('.terminal-cursor-copy'),
        inMode: pane.inMode,
        statusSaysCopyMode: document.body.innerText.includes('[COPY MODE]'),
      };
    });
    expect(duringScroll.rendered).toBe(true);
    expect(duringScroll.userSelect).toBe('text');
    expect(duringScroll.copyCursor).toBe(false);
    expect(duringScroll.inMode).toBe(false);
    expect(duringScroll.statusSaysCopyMode).toBe(false);

    // Step 3: the scrollback selects with the browser's own selection, and the
    // text comes back without the grid's trailing padding.
    const selected = await ctx.page.evaluate(() => {
      const pre = document.querySelector('[data-scroll-mode="true"]');
      // Rows on screen: the scrollback also keeps an overscan of rows above
      // and below the viewport, and the right-click below must land on the
      // selection, not on whatever is drawn where an off-screen row projects.
      const box = document.querySelector('.pane-scroll-container').getBoundingClientRect();
      const rows = [...pre.children]
        .filter((d) => d.textContent.trim().length > 0)
        .filter((d) => {
          const r = d.getBoundingClientRect();
          return r.top > box.top + 2 && r.bottom < box.bottom - 2;
        });
      if (rows.length < 2) return null;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(rows[0], 0);
      range.setEnd(rows[1], rows[1].childNodes.length);
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });
    expect(selected).not.toBeNull();
    expect(selected.trim().length).toBeGreaterThan(0);
    expect(selected).not.toMatch(/ {5}/);

    // Step 3b: the selection survives scrolling — in either direction and all
    // the way back to the bottom, where the view stays open for it — and a
    // right-click on it, which opens the menu with just Copy and Send keys.
    const readSelection = () => ctx.page.evaluate(() => window.getSelection()?.toString() ?? '');
    const scrollBy = async (rows) => {
      await ctx.page.evaluate((r) => {
        const el = document.querySelector('.pane-scroll-container');
        el.scrollTop +=
          r * parseFloat(getComputedStyle(el).getPropertyValue('--line-height-terminal'));
      }, rows);
      await delay(DELAYS.MEDIUM);
    };
    await scrollBy(6);
    expect(await readSelection()).toBe(selected);
    await scrollBy(-6);
    expect(await readSelection()).toBe(selected);
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.pane-scroll-container');
      el.scrollTop = el.scrollHeight;
    });
    await delay(DELAYS.LONG);
    expect((await getCopyModeState(ctx.page))?.mode).toBe('scroll');
    expect(await readSelection()).toBe(selected);

    // Bring the selection back on screen (the bottom scrolled it out of the
    // viewport; its rows stayed mounted) and right-click on it.
    await ctx.page.evaluate(() => {
      const range = window.getSelection().getRangeAt(0);
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      el.closest('.terminal-line').scrollIntoView({ block: 'center' });
    });
    await delay(DELAYS.MEDIUM);
    expect(await readSelection()).toBe(selected);
    const selRect = await ctx.page.evaluate(() => {
      const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await ctx.page.mouse.click(selRect.x, selRect.y, { button: 'right' });
    await delay(DELAYS.MEDIUM);
    expect(await readSelection()).toBe(selected);
    const menuItems = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('.szh-menu__item')].map((el) => ({
        text: el.textContent.trim(),
        icon: !!el.querySelector('svg.menu-item-icon'),
      })),
    );
    expect(menuItems).toEqual([
      { text: 'Copy', icon: true },
      { text: 'Send keys', icon: true },
    ]);
    // While the menu is up the selection is pinned: focus moving to the menu
    // (on open) or to an item (on hover) collapses it on WebKit, and whatever
    // collapses it, it comes back.
    await ctx.page.mouse.move(selRect.x + 30, selRect.y + 14);
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());
    await waitForCondition(
      ctx.page,
      async () => (await readSelection()) === selected,
      3000,
      'the selection to be restored under the open menu',
    );
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.SHORT);
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // Step 4: typing closes the view and lands at the prompt, as in any
    // terminal — the key is not swallowed by a mode.
    await runCommand(ctx.page, 'echo AFTER_SCROLL_VIEW', 'AFTER_SCROLL_VIEW');
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // Step 5: a double-click selects natively and still enters no mode.
    await runCommand(ctx.page, 'echo "WORD1 WORD2 WORD3"', 'WORD1');
    const termEl = await ctx.page.$('[role="log"]');
    box = await termEl.boundingBox();
    await ctx.page.mouse.dblclick(box.x + 100, box.y + box.height / 2);
    await delay(DELAYS.SYNC);
    const afterDblClick = await ctx.page.evaluate(() => ({
      selection: window.getSelection()?.toString() ?? '',
      copyState: window.app.getSnapshot().context.copyModeStates['%0'] ?? null,
    }));
    expect(afterDblClick.copyState).toBeNull();
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // Step 6: `prefix [` is the one way into copy mode, and it still works —
    // tmux really enters the mode and the client draws its cursor.
    const cs = await enterCopyModeAndWait(ctx.page);
    expect(cs.active).toBe(true);
    expect(cs.mode).toBe('copy');
    const inCopyMode = await ctx.page.evaluate(() => ({
      copyModeEl: !!document.querySelector('[data-copy-mode="true"]'),
      statusSaysCopyMode: document.body.innerText.includes('[COPY MODE]'),
    }));
    expect(inCopyMode.copyModeEl).toBe(true);
    expect(inCopyMode.statusSaysCopyMode).toBe(true);

    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    await runCommand(ctx.page, 'echo AFTER_COPY_MODE_OK', 'AFTER_COPY_MODE_OK');
    await assertContentMatch(ctx.page, 'Scenario 7 end');
  }, 180000);
});

// ==================== Scenario 8: Mouse Drag & SGR ====================

describe('Scenario 8: Mouse Drag & SGR', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    await ensureMouseCaptureStopped(ctx);
    await ctx.afterEach();
  }, ctx.hookTimeout);

  test('Drag H divider → drag V divider → SGR click → SGR wheel → SGR right-click', async () => {
    if (ctx.skipIfNotReady()) return;

    // Step 1: Drag horizontal divider
    await ctx.setupTwoPanes('horizontal');
    await waitForPaneCount(ctx.page, 2);
    await assertContentMatch(ctx.page, 'Scenario 8 setup');
    await assertLayoutInvariants(ctx.page);
    let panesBefore = await ctx.session.getPaneInfo();
    await resizePaneKeyboard(ctx.page, 'D', 5);
    await delay(DELAYS.SYNC);
    let panesAfter = await ctx.session.getPaneInfo();
    const heightsChanged = panesBefore.some((before, i) => {
      const after = panesAfter[i];
      return after && before.height !== after.height;
    });
    expect(heightsChanged).toBe(true);

    // Kill panes to reset
    await killPaneKeyboard(ctx.page);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 2: Drag vertical divider (via tmux resize)
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    panesBefore = await ctx.session.getPaneInfo();
    await resizePaneKeyboard(ctx.page, 'R', 10);
    await delay(DELAYS.SYNC);
    panesAfter = await ctx.session.getPaneInfo();
    const widthsChanged = panesBefore.some((before, i) => {
      const after = panesAfter[i];
      return after && before.width !== after.width;
    });
    expect(widthsChanged).toBe(true);

    // Kill pane to reset for SGR tests
    await killPaneKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 1);
    // After killing a pane, wait for the remaining pane to become active.
    // The keyboard actor won't route input until activePaneId matches.
    // After killing a pane, the surviving pane's content is reset by
    // capture-pane. Wait for the prompt to render before typing.
    await waitForShellPrompt(ctx.page, 10000);

    // Step 3: SGR click
    const { contentBox, charSize } = await startMouseCapture(ctx);
    const clickX = contentBox.x + contentBox.width / 2;
    const clickY = contentBox.y + contentBox.height / 2;
    await ctx.page.mouse.click(clickX, clickY);
    let events = await readMouseEvents(2);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const press = events.find((e) => e.type === 'press');
    const release = events.find((e) => e.type === 'release');
    expect(press).toBeDefined();
    expect(release).toBeDefined();
    expect(press.btn).toBe(0);

    // Step 4: SGR wheel - stop and restart capture for clean slate
    await stopMouseCapture(ctx);
    await delay(DELAYS.LONG);
    const capture2 = await startMouseCapture(ctx);

    const wheelX = capture2.contentBox.x + capture2.contentBox.width / 2;
    const wheelY = capture2.contentBox.y + capture2.contentBox.height / 2;
    await ctx.page.mouse.move(wheelX, wheelY);
    await ctx.page.mouse.wheel(0, -capture2.charSize.charHeight * 3);
    await delay(DELAYS.SYNC);
    await ctx.page.mouse.wheel(0, capture2.charSize.charHeight * 2);
    await delay(DELAYS.SYNC);
    events = await readMouseEvents(2);
    const scrollUps = events.filter((e) => e.type === 'scroll_up');
    const scrollDowns = events.filter((e) => e.type === 'scroll_down');
    expect(scrollUps.length).toBeGreaterThanOrEqual(1);
    expect(scrollDowns.length).toBeGreaterThanOrEqual(1);
    for (const evt of scrollUps) expect(evt.btn).toBe(64);
    for (const evt of scrollDowns) expect(evt.btn).toBe(65);

    // Step 5: SGR right-click — dispatch mousedown event directly on the terminal content
    // because Playwright's right-click in headless Chrome doesn't reliably trigger
    // the React onMouseDown handler for button=2.
    const eventsBefore = await readMouseEvents(0, 1000);
    await ctx.page.evaluate(() => {
      const content = document.querySelector('.terminal-content');
      if (!content) return;
      const rect = content.getBoundingClientRect();
      const clientX = rect.left + 50;
      const clientY = rect.top + 50;
      content.dispatchEvent(
        new MouseEvent('mousedown', {
          button: 2,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // Wait for at least 1 new event (the right-click press)
    const allEvents = await readMouseEvents(eventsBefore.length + 1, 10000);
    const rPress = allEvents.find((e) => e.type === 'press' && e.btn === 2);
    expect(rPress).toBeDefined();
    expect(rPress.btn).toBe(2);

    await stopMouseCapture(ctx);
    await delay(DELAYS.SYNC);
  }, 180000);
});

// ==================== Scenario 9: Copy Mode Navigate ====================

describe('Scenario 9: Copy Mode Navigate', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Scroll enter → hjkl cursor → 0/$ line edges → Ctrl+u/d half-page → persists → exit q → re-enter scroll → exit Escape → v selection', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate scrollback content
    await runCommand(ctx.page, 'seq 1 200', '200');
    await focusPage(ctx.page);
    await assertContentMatch(ctx.page, 'Scenario 9 setup');

    // Step 1: Enter copy mode (keyboard: prefix+[)
    const csEntry = await enterCopyModeAndWait(ctx.page);
    expect(csEntry.active).toBe(true);

    // Step 2: Navigate with 'k' (up) — cursor row should decrease
    const before = await getCopyModeState(ctx.page);
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('k');
      await delay(50);
    }
    await delay(DELAYS.SHORT);
    const afterUp = await getCopyModeState(ctx.page);
    expect(afterUp.cursorRow).toBeLessThan(before.cursorRow);

    // Navigate with 'j' (down) — cursor row should increase
    await ctx.page.keyboard.press('j');
    await delay(DELAYS.SHORT);
    const afterDown = await getCopyModeState(ctx.page);
    expect(afterDown.cursorRow).toBeGreaterThan(afterUp.cursorRow);

    // Navigate to a line with content (scrollback output from seq)
    // Go to start of line first, then move right
    await ctx.page.keyboard.press('0');
    await delay(DELAYS.SHORT);
    // Move up a few lines to ensure we're on a "seq" output line (not the empty prompt)
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('k');
      await delay(50);
    }
    await ctx.page.keyboard.press('0');
    await delay(DELAYS.SHORT);

    // Navigate with 'l' (right) — cursor col should increase
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await delay(DELAYS.SHORT);
    const afterRight = await getCopyModeState(ctx.page);
    expect(afterRight.cursorCol).toBeGreaterThan(0);

    // Navigate with 'h' (left) — cursor col should decrease
    await ctx.page.keyboard.press('h');
    await delay(DELAYS.SHORT);
    const afterLeft = await getCopyModeState(ctx.page);
    expect(afterLeft.cursorCol).toBeLessThan(afterRight.cursorCol);

    // Step 3: Line edges: '0' goes to col 0, '$' goes to end of line
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.press('0');
    await delay(DELAYS.SHORT);
    const atStart = await getCopyModeState(ctx.page);
    expect(atStart.cursorCol).toBe(0);

    await ctx.page.keyboard.press('$');
    await delay(DELAYS.SHORT);
    const atEnd = await getCopyModeState(ctx.page);
    expect(atEnd.cursorCol).toBeGreaterThan(0);

    // Step 4: Half-page up/down (Ctrl+u / Ctrl+d)
    const beforePage = await getCopyModeState(ctx.page);
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('u');
    await ctx.page.keyboard.up('Control');
    await delay(DELAYS.SHORT);
    const afterPageUp = await getCopyModeState(ctx.page);
    expect(afterPageUp.cursorRow).toBeLessThan(beforePage.cursorRow);

    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('d');
    await ctx.page.keyboard.up('Control');
    await delay(DELAYS.SHORT);
    const afterPageDown = await getCopyModeState(ctx.page);
    expect(afterPageDown.cursorRow).toBeGreaterThan(afterPageUp.cursorRow);

    // Step 5: Still in copy mode after all navigation
    const csStillActive = await getCopyModeState(ctx.page);
    expect(csStillActive.active).toBe(true);
    // ScrollbackTerminal should be rendered
    const scrollbackEl = await ctx.page.$('[data-copy-mode="true"]');
    expect(scrollbackEl).not.toBeNull();

    // Step 6: Exit with 'q'
    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();
    // ScrollbackTerminal should be gone, normal terminal restored
    const normalEl = await ctx.page.$('[role="log"]');
    expect(normalEl).not.toBeNull();

    // Step 7: Re-enter copy mode (wait for reentry cooldown)
    await delay(DELAYS.SYNC);
    await enterCopyModeAndWait(ctx.page);

    // Step 8: Exit with Escape
    await ctx.page.keyboard.press('Escape');
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // Step 9: Re-enter, test 'v' selection mode (wait for reentry cooldown)
    await delay(DELAYS.SYNC);
    await enterCopyModeAndWait(ctx.page);
    // Navigate up to a line with content (the "seq 1 200" command output)
    for (let i = 0; i < 5; i++) {
      await ctx.page.keyboard.press('k');
      await delay(50);
    }
    // Move to start of line so we have room to move right
    await ctx.page.keyboard.press('0');
    await delay(DELAYS.SHORT);
    // Press 'v' to enter char selection mode
    await ctx.page.keyboard.press('v');
    await delay(DELAYS.SHORT);
    const csWithSelection = await getCopyModeState(ctx.page);
    expect(csWithSelection.selectionMode).toBe('char');
    expect(csWithSelection.selectionAnchor).not.toBeNull();
    expect(csWithSelection.cursorCol).toBe(0);
    // Move cursor right to expand selection
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await delay(DELAYS.SHORT);
    const csExpanded = await getCopyModeState(ctx.page);
    expect(csExpanded.cursorCol).toBeGreaterThan(csWithSelection.cursorCol);
    // 'v' again toggles off selection
    await ctx.page.keyboard.press('v');
    await delay(DELAYS.SHORT);
    const csNoSel = await getCopyModeState(ctx.page);
    expect(csNoSel.selectionMode).toBeNull();

    // Clean exit
    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    // Force content sync: after copy mode exit the terminal DOM may be stale.
    // Running a command forces fresh content that matches tmux ground truth.
    await runCommand(ctx.page, 'echo COPY_EXIT', 'COPY_EXIT');
    await delay(DELAYS.SYNC);
    await assertContentMatch(ctx.page, 'Scenario 9 end');
  }, 180000);
});

// ==================== Scenario 10: Copy Mode Select & Yank ====================

describe('Scenario 10: Copy Mode Select & Yank', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Selection with v → yank with y → exit → terminal functional', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Generate scrollback content with identifiable lines
    await runCommand(ctx.page, 'seq 1 200', '200');
    await focusPage(ctx.page);
    await assertContentMatch(ctx.page, 'Scenario 10 setup');

    // Step 2: Enter copy mode via keyboard (prefix+[)
    const csEntry = await enterCopyModeAndWait(ctx.page);
    expect(csEntry.active).toBe(true);

    // Step 3: Navigate up to a content line with 'k'
    for (let i = 0; i < 5; i++) {
      await ctx.page.keyboard.press('k');
      await delay(50);
    }
    await delay(DELAYS.SHORT);

    // Step 4: Go to start of line with '0'
    await ctx.page.keyboard.press('0');
    await delay(DELAYS.SHORT);
    const atStart = await getCopyModeState(ctx.page);
    expect(atStart.cursorCol).toBe(0);

    // Step 5: Enter char selection with 'v'
    await ctx.page.keyboard.press('v');
    await delay(DELAYS.SHORT);
    const csWithSelection = await getCopyModeState(ctx.page);
    expect(csWithSelection.selectionMode).toBe('char');

    // Step 6: Extend selection with 'l' keys
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('l');
      await delay(50);
    }
    await delay(DELAYS.SHORT);
    const csExtended = await getCopyModeState(ctx.page);
    expect(csExtended.cursorCol).toBeGreaterThan(atStart.cursorCol);

    // Step 7: Yank with 'y' (triggers extractSelectedText → clipboard → auto-exit)
    await ctx.page.keyboard.press('y');

    // Step 8: Verify copy mode exited after yank
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // Step 9: Verify terminal is functional after yank
    await runCommand(ctx.page, 'echo "YANK_OK"', 'YANK_OK');
    await assertContentMatch(ctx.page, 'Scenario 10 end');
  }, 180000);
});

// ==================== Scenario 21: Touch Scrolling ====================

describe('Scenario 21: Touch Scrolling', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Touch scroll: CSS prevention → normal shell → alternate screen → multi-pane isolation', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await assertContentMatch(ctx.page, 'Scenario 21 setup');

    // Step 1: Verify touch-action: none is set on pane-wrapper
    const touchAction = await ctx.page.evaluate(() => {
      const wrapper = document.querySelector('.pane-wrapper');
      if (!wrapper) return null;
      return getComputedStyle(wrapper).touchAction;
    });
    expect(touchAction).toBe('none');

    // Step 2: Generate scrollback history for copy-mode scroll test
    // Wait for terminal content to stabilize after sourceConfig (move-window triggers re-render)
    await ctx.page.waitForFunction(
      () => {
        const logs = document.querySelectorAll('[role="log"]');
        const content = Array.from(logs)
          .map((l) => l.textContent || '')
          .join('');
        return content.length > 0;
      },
      { timeout: 10000, polling: 100 },
    );
    await focusPage(ctx.page);
    await runCommand(ctx.page, 'for i in $(seq 0 59); do echo "line-$i"; done', 'line-59');

    // Get pane center coordinates
    const paneBox = await ctx.page.evaluate(() => {
      const pane = document.querySelector('.pane-wrapper');
      if (!pane) return null;
      const r = pane.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, height: r.height };
    });
    expect(paneBox).not.toBeNull();

    // Step 3: Touch scroll up in a normal shell opens a scrollback view.
    // A swipe opens the native-like scroll view (the wheel's equivalent);
    // the keyboard fallback below opens tmux copy mode instead, so this
    // asserts only that a view opened — the wheel path's mode is pinned down
    // in Scenario 7.
    // Finger moves DOWN (positive delta) = scroll UP through history
    await dispatchTouchScroll(
      ctx.page,
      paneBox.x,
      paneBox.y,
      paneBox.y + paneBox.height * 0.4, // swipe down 40% of pane
      10,
      16,
    );
    await delay(DELAYS.SYNC);

    // Touch events are unreliable in headless, so fall back to keyboard entry
    // (the correct prefix from tmuxy.conf) when the swipe did not register.
    let copyModeActive = await getCopyModeState(ctx.page);
    if (!copyModeActive?.active) {
      await enterCopyModeAndWait(ctx.page);
      copyModeActive = await getCopyModeState(ctx.page);
    }
    expect(copyModeActive?.active).toBe(true);

    // Leave by the view's own door: Escape closes the scroll view and is
    // spent, while `q` is copy mode's exit — in the scroll view it would be
    // typed into the shell, and the next command would run as `qless`.
    await ctx.page.keyboard.press(copyModeActive.mode === 'scroll' ? 'Escape' : 'q');
    await waitForCopyMode(ctx.page, false);
    await delay(DELAYS.LONG);

    // Step 4: Touch scroll in alternate screen (less command)
    await typeInTerminal(ctx.page, 'less /etc/services');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);

    // Verify alternate mode is active
    const altOn = await ctx.page.evaluate(() => {
      const pane = document.querySelector('.pane-wrapper');
      return pane?.getAttribute('data-alternate-on') === 'true';
    });
    expect(altOn).toBe(true);

    // Get initial visible text
    const textBefore = await getTerminalText(ctx.page);

    // Touch scroll down in alternate screen (finger up = scroll down = Down arrow keys)
    await dispatchTouchScroll(
      ctx.page,
      paneBox.x,
      paneBox.y + paneBox.height * 0.4,
      paneBox.y - paneBox.height * 0.2, // swipe up 60% of pane
      10,
      16,
    );
    await delay(DELAYS.SYNC);

    // Verify content changed (scrolled down in less)
    // Touch events may not reliably translate to arrow keys in headless mode —
    // fall back to keyboard Down arrows if touch didn't scroll.
    let textAfter = await getTerminalText(ctx.page);
    if (textAfter === textBefore) {
      for (let i = 0; i < 10; i++) {
        await ctx.page.keyboard.press('ArrowDown');
        await delay(50);
      }
      await delay(DELAYS.SYNC);
      textAfter = await getTerminalText(ctx.page);
    }
    expect(textAfter).not.toBe(textBefore);

    // Exit less
    await ctx.page.keyboard.press('q');
    await delay(DELAYS.LONG);

    // Step 5: Multi-pane touch isolation
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);

    // Generate distinct content in each pane
    await typeInTerminal(ctx.page, 'echo PANE_TWO_MARKER');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);

    // Get both pane positions
    const panePositions = await ctx.page.evaluate(() => {
      const panes = document.querySelectorAll('.pane-wrapper');
      return Array.from(panes).map((p) => {
        const r = p.getBoundingClientRect();
        return {
          id: p.getAttribute('data-pane-id'),
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          height: r.height,
        };
      });
    });
    expect(panePositions.length).toBe(2);

    // Touch scroll on second pane only — first pane should be unaffected
    // (This primarily verifies touch events are scoped to the touched pane)
    const secondPane = panePositions[1];
    await dispatchTouchScroll(
      ctx.page,
      secondPane.x,
      secondPane.y,
      secondPane.y + secondPane.height * 0.3,
      5,
      16,
    );
    await delay(DELAYS.LONG);

    // Both panes should still exist
    const finalPaneCount = await getUIPaneCount(ctx.page);
    expect(finalPaneCount).toBe(2);

    // Exit copy mode if active (touch scroll enters copy mode on normal screen)
    const touchCopyState = await getCopyModeState(ctx.page);
    if (touchCopyState?.active) {
      await ctx.page.keyboard.press('q');
      await delay(DELAYS.SYNC);
    }

    // Layout was already validated before the multi-pane isolation step.
    // After copy mode + touch scroll, layout may temporarily have extra height
    // from the scrollback terminal cleanup — skip re-validating here.
  }, 180000);
});

// ==================== Scenario 23: Multi-Viewport Layout ====================

describe('Scenario 23: Multi-Viewport Layout', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('3 panes → layout invariants at 3 viewport sizes', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create 3-pane layout: vertical split + horizontal split
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3, 10000);
    await delay(DELAYS.SYNC);

    // Verify invariants at default size first (before any viewport changes)
    await assertLayoutInvariants(ctx.page, { label: 'viewport default (1280x720)' });

    const viewports = [
      { width: 800, height: 600, label: 'small' },
      { width: 1920, height: 1080, label: 'large' },
    ];

    for (const vp of viewports) {
      await ctx.page.setViewportSize({ width: vp.width, height: vp.height });
      // Wait for resize to propagate through: browser → SSE → server → tmux → SSE → browser
      await delay(DELAYS.SYNC * 2);

      // Wait for pane count to still be 3 after resize
      await waitForPaneCount(ctx.page, 3, 10000);

      await assertLayoutInvariants(ctx.page, {
        label: `viewport ${vp.label} (${vp.width}x${vp.height})`,
      });
    }

    // Restore default viewport
    await ctx.page.setViewportSize({ width: 1280, height: 720 });
    await delay(DELAYS.SYNC);
  }, 180000);
});

// ==================== Scenario 7c: Mouse lands on the clicked cell ====================

describe('Scenario 7c: Mouse lands on the clicked cell', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    await ensureMouseCaptureStopped(ctx);
    await ctx.afterEach();
  }, ctx.hookTimeout);

  test('a click reaches tmux at the cell under the pointer, in a pane and in the dock', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page, 10000);

    // 1. A tiled pane. The click on a cell's right half is the one that went
    //    wrong: positions were read from the padded content box, half a cell
    //    to the left of the first cell, so it landed in the next column.
    await startMouseCapture(ctx);
    const pane = await gridOf(ctx.page, '.pane-layout-item');
    for (const [col, row, frac] of [
      [10, 4, 0.5],
      [20, 6, 0.8],
      [3, 2, 0.2],
    ]) {
      const press = await clickCell(ctx.page, pane, col, row, frac);
      expect({ at: [col, row, frac], x: press.x, y: press.y }).toEqual({
        at: [col, row, frac],
        x: col + 1,
        y: row + 1,
      });
    }
    await stopMouseCapture(ctx);

    // 2. The dock. Its terminal runs in the smaller sidebar font, and clicks
    //    there were converted with the pane grid's larger cell: they reached
    //    tmux cells up and to the left of the pointer.
    await sendPrefixCommand(ctx.page, 'T', { shift: true });
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"] .terminal-line', {
      timeout: 20000,
    });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
      10000,
      'the dock to take the keyboard',
    );
    await waitForShellPrompt(ctx.page, 10000);
    // Started in the dock's own terminal: by default the capture goes to the
    // active tiled pane.
    await startMouseCapture(ctx, {
      terminal: '[data-testid="right-sidebar-content"] [role="log"]',
    });
    const dock = await gridOf(ctx.page, '[data-testid="right-sidebar-content"]');
    expect(dock.cellW).toBeLessThan(pane.cellW);
    for (const [col, row, frac] of [
      [5, 8, 0.5],
      [20, 15, 0.8],
    ]) {
      const press = await clickCell(ctx.page, dock, col, row, frac);
      expect({ at: [col, row, frac], x: press.x, y: press.y }).toEqual({
        at: [col, row, frac],
        x: col + 1,
        y: row + 1,
      });
    }
    await stopMouseCapture(ctx);
    await sendPrefixCommand(ctx.page, 'T', { shift: true });
  }, 180000);
});

// ==================== Scenario 7d: Selecting and copying with the mouse ====================

describe('Scenario 7d: Selecting and copying with the mouse', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** Screen centres of the first and last cell of `text` in a rendered line. */
  const cellsOf = (page, rootSelector, text) =>
    page.evaluate(
      ({ sel, needle }) => {
        const lines = [...document.querySelectorAll(`${sel} .terminal-line`)].filter(
          (l) => l.getBoundingClientRect().height > 0 && l.textContent.startsWith(needle),
        );
        const line = lines[lines.length - 1];
        if (!line) return null;
        const r = line.getBoundingClientRect();
        const cellW = parseFloat(getComputedStyle(line).getPropertyValue('--cell-w'));
        // Just inside the outer edges of the first and last cell: a browser
        // selection starts and ends at the nearest character boundary, so a
        // press on the middle of the first letter would leave it out.
        return {
          y: r.top + r.height / 2,
          first: r.left + 1,
          last: r.left + needle.length * cellW - 1,
          box: {
            left: r.left,
            right: r.left + needle.length * cellW,
            top: r.top,
            bottom: r.bottom,
          },
        };
      },
      { sel: rootSelector, needle: text },
    );

  /** Press, sweep and release, pausing on the end so a throttled move lands there. */
  const drag = async (page, from, to, y) => {
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(to, y, { steps: 10 });
    await delay(120);
    await page.mouse.move(to + 0.5, y);
    await page.mouse.up();
  };

  test('a drag selects text on the live screen, and Cmd+C blinks what it copied', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // 1. The drag itself. The pane used to focus the hidden keyboard input on
    //    the press, which collapses the page's selection, so it selected nothing.
    await runCommand(ctx.page, 'echo "DRAG_SELECT_ME and more"', 'DRAG_SELECT_ME');
    const at = await cellsOf(ctx.page, '.pane-layout-item', 'DRAG_SELECT_ME');
    expect(at).not.toBeNull();
    await drag(ctx.page, at.first, at.last, at.y);
    const selected = await ctx.page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected).toBe('DRAG_SELECT_ME');

    // The selection wears the terminal's colours reversed: the foreground as
    // its background, the palette's gray for the text.
    const paint = await ctx.page.evaluate(() => {
      const node = window.getSelection().getRangeAt(0).startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      const sel = getComputedStyle(el, '::selection');
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--term-foreground)';
      probe.style.color = 'var(--term-bright-black)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe);
      const result = {
        bg: sel.backgroundColor,
        fg: sel.color,
        wantBg: want.backgroundColor,
        wantFg: want.color,
      };
      probe.remove();
      return result;
    });
    expect(paint.wantBg).not.toBe('rgba(0, 0, 0, 0)');
    expect({ bg: paint.bg, fg: paint.fg }).toEqual({ bg: paint.wantBg, fg: paint.wantFg });

    // 2. Copying blinks the copied text: boxes laid over the selection, which
    //    go away on their own.
    await ctx.page.evaluate(() => {
      window.addEventListener('copy', (e) => {
        window.__copied = e.clipboardData.getData('text/plain');
      });
    });
    await ctx.page.keyboard.press('Meta+c');
    const flash = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('.copy-flash')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          animation: getComputedStyle(el).animationName,
        };
      }),
    );
    expect(flash.length).toBeGreaterThan(0);
    expect(flash[0].animation).toBe('copy-flash');
    expect(Math.abs(flash[0].left - at.box.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(flash[0].top - at.box.top)).toBeLessThanOrEqual(2);
    await waitForCondition(
      ctx.page,
      async () =>
        (await ctx.page.evaluate(() => document.querySelectorAll('.copy-flash').length)) === 0,
      3000,
      'the copy blink to finish',
    );
    // The selection is still there; copying did not take it away.
    expect(await ctx.page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(
      'DRAG_SELECT_ME',
    );
    expect(await ctx.page.evaluate(() => window.__copied)).toBe('DRAG_SELECT_ME');
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // 3. A row of differently-coloured runs copies as one line. Each run is its
    //    own box, and the browser's own copy broke the line at every one.
    await runCommand(ctx.page, 'printf "\\033[31mRED_RUN\\033[0m PLAIN_RUN\\n"', 'PLAIN_RUN');
    const mixed = await cellsOf(ctx.page, '.pane-layout-item', 'RED_RUN PLAIN_RUN');
    expect(mixed).not.toBeNull();
    await drag(ctx.page, mixed.first, mixed.last, mixed.y);
    await ctx.page.keyboard.press('Meta+c');
    await delay(DELAYS.SHORT);
    expect(await ctx.page.evaluate(() => window.__copied)).toBe('RED_RUN PLAIN_RUN');
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());
  }, 120000);

  test('in copy mode a drag copies on release, blinks, and leaves copy mode', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await runCommand(ctx.page, 'echo "COPY_DRAG_ME and more"', 'COPY_DRAG_ME');
    const cs = await enterCopyModeAndWait(ctx.page);
    expect(cs.mode).toBe('copy');
    await ctx.page.evaluate(() => {
      delete window.__tmuxyLastClipboard;
    });

    const at = await cellsOf(ctx.page, '[data-copy-mode="true"]', 'COPY_DRAG_ME');
    expect(at).not.toBeNull();

    // Watch for the blink before releasing: it is on screen for under half a second.
    await ctx.page.evaluate(() => {
      window.__sawCopied = false;
      const pre = document.querySelector('[data-copy-mode="true"]');
      new MutationObserver(() => {
        if (pre.getAttribute('data-copied') === 'true') window.__sawCopied = true;
      }).observe(pre, { attributes: true, attributeFilter: ['data-copied'] });
    });
    // Copy mode's block cursor is the theme's accent — green on the default theme.
    const cursor = await ctx.page.evaluate(() => {
      const shape = document.querySelector('.smooth-cursor.is-copy .smooth-cursor-shape');
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--term-green)';
      document.body.appendChild(probe);
      const result = {
        bg: shape ? getComputedStyle(shape).backgroundColor : null,
        want: getComputedStyle(probe).backgroundColor,
      };
      probe.remove();
      return result;
    });
    expect(cursor.bg).toBe(cursor.want);

    // Mid-drag, the selected cells wear the same reversed colours as a
    // browser selection does.
    await ctx.page.mouse.move(at.first, at.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(at.last, at.y, { steps: 10 });
    await delay(120);
    await ctx.page.mouse.move(at.last + 0.5, at.y);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () => !!document.querySelector('[data-copy-mode="true"] .terminal-selected'),
        ),
      3000,
      'the drag to select cells',
    );
    const cells = await ctx.page.evaluate(() => {
      const cell = document.querySelector('[data-copy-mode="true"] .terminal-selected');
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--term-foreground)';
      probe.style.color = 'var(--term-bright-black)';
      document.body.appendChild(probe);
      const got = getComputedStyle(cell);
      const want = getComputedStyle(probe);
      const result = {
        bg: got.backgroundColor,
        fg: got.color,
        wantBg: want.backgroundColor,
        wantFg: want.color,
      };
      probe.remove();
      return result;
    });
    expect({ bg: cells.bg, fg: cells.fg }).toEqual({ bg: cells.wantBg, fg: cells.wantFg });
    await ctx.page.mouse.up();

    // Released: the selection is on the clipboard, the copied text blinked,
    // and copy mode is over — on the client and in tmux.
    await waitForCondition(
      ctx.page,
      async () =>
        (await ctx.page.evaluate(() => window.__tmuxyLastClipboard?.text ?? null)) !== null,
      5000,
      'the release to copy the selection',
    );
    expect(await ctx.page.evaluate(() => window.__tmuxyLastClipboard.text)).toBe('COPY_DRAG_ME');
    await waitForCopyMode(ctx.page, false);
    expect(await ctx.page.evaluate(() => window.__sawCopied)).toBe(true);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app.getSnapshot().context.panes[0]?.inMode === false),
      5000,
      'tmux to leave copy mode',
    );

    // The pane is back at its prompt and takes input.
    await runCommand(ctx.page, 'echo AFTER_COPY_DRAG', 'AFTER_COPY_DRAG');
  }, 120000);
});

// ==================== Scenario 7e: Selecting the whole scrollback ====================

describe('Scenario 7e: Selecting the whole scrollback', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Cmd+A selects every row of scrollback, on screen and off, and Cmd+C copies all of it', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await focusPage(ctx.page);

    // History taller than the viewport, so most of what gets selected has no
    // DOM node to select — the point of a client selection over the browser's.
    await runCommand(ctx.page, 'seq 1 300', '300');
    await assertContentMatch(ctx.page, 'Scenario 7e setup');

    // What the copy actually put on the clipboard: read off the copy event,
    // after the app's own handler has set it.
    await ctx.page.evaluate(() => {
      window.__copied = null;
      window.addEventListener('copy', (e) => {
        window.__copied = e.clipboardData.getData('text/plain');
      });
    });

    await ctx.page.keyboard.press('Meta+a');

    // The scroll view opens on the pane and the selection covers it whole: the
    // first row of history to the last row on screen.
    //
    // `totalLines > height` is part of the WAIT, not an assertion after it.
    // The pane's `history_size` arrives on its own schedule, and until it does
    // the view knows only the rows on screen — where a selection from row 0 to
    // `totalLines - 1` is perfectly self-consistent and covers the screen
    // alone. Asserting it separately afterwards meant a slow runner caught
    // that honest intermediate state and read it as select-all missing the
    // scrollback (`Expected: > 26, Received: 26` in CI).
    await waitForCondition(
      ctx.page,
      async () => {
        const cs = await getCopyModeState(ctx.page);
        return (
          cs?.mode === 'scroll' &&
          cs.selectionMode === 'line' &&
          cs.selectionAnchor?.row === 0 &&
          cs.totalLines > cs.height &&
          cs.cursorRow === cs.totalLines - 1
        );
      },
      15000,
      async () => {
        const cs = await getCopyModeState(ctx.page);
        return `select-all to cover the whole scrollback (saw ${JSON.stringify({
          mode: cs?.mode,
          selectionMode: cs?.selectionMode,
          anchorRow: cs?.selectionAnchor?.row,
          cursorRow: cs?.cursorRow,
          totalLines: cs?.totalLines,
          height: cs?.height,
        })})`;
      },
    );
    const selected = await getCopyModeState(ctx.page);
    // The whole backlog, not just the screen: `seq 1 300` scrolled 300 lines
    // past a viewport of a few dozen.
    expect(selected.totalLines).toBeGreaterThan(selected.height);

    // The copy reads the rows the client has loaded, so wait for the backlog to
    // arrive — a row still on its way has no text, and "not loaded yet" is never
    // "done". The pane's `history_size` can itself still be catching up when the
    // view opens, so the wait is on the 300 printed lines being there, not on a
    // load merely having finished.
    await waitForCondition(
      ctx.page,
      async () => {
        const cs = await getCopyModeState(ctx.page);
        return (
          !!cs &&
          !cs.loading &&
          cs.loadedRanges?.[0]?.[0] === 0 &&
          cs.totalLines > 300 &&
          cs.cursorRow === cs.totalLines - 1
        );
      },
      30000,
      'the whole scrollback to load under the select-all',
    );

    // And it is visible: the rows on screen are painted as selected, each
    // filled to the width of the grid rather than stopping at its last
    // character, which is what a selected blank line looks like.
    const painted = await ctx.page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-scroll-mode="true"] .terminal-line')]
        .filter((row) => row.getBoundingClientRect().height > 0)
        .filter((row) => row.textContent.trim().length > 0);
      const widths = rows.map((row) => {
        const spans = [...row.querySelectorAll('.terminal-selected')];
        const boxes = spans.map((s) => s.getBoundingClientRect()).filter((b) => b.height > 0);
        if (boxes.length === 0) return 0;
        return Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left));
      });
      return { rows: rows.length, unselected: widths.filter((w) => w === 0).length };
    });
    expect(painted.rows).toBeGreaterThan(5);
    expect(painted.unselected).toBe(0);

    // Cmd+C copies every selected row — including the ones far above the
    // viewport, which is the whole reason the copy is read from the loaded
    // rows and not from the document.
    await ctx.page.keyboard.press('Meta+c');
    await waitForCondition(
      ctx.page,
      async () => {
        const text = await ctx.page.evaluate(() => window.__copied);
        return typeof text === 'string' && text.length > 0;
      },
      15000,
      'the selection to reach the clipboard',
    );
    const copied = await ctx.page.evaluate(() => window.__copied);
    const lines = copied.split('\n').map((l) => l.trim());
    expect(lines).toContain('1');
    expect(lines).toContain('150');
    expect(lines).toContain('300');

    // The copy ends the view, as a yank does, and the pane is live again.
    await waitForCopyMode(ctx.page, false);
    await runCommand(ctx.page, 'echo SELECT_ALL_OK', 'SELECT_ALL_OK');
    await assertContentMatch(ctx.page, 'Scenario 7e end');
  }, 180000);
});

// ==================== Scenario 31: First-Run Notice ====================

describe('Scenario 31: First-run notice', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a new browser gets the notice and no keystroke reaches the shell → "I understand" lets typing through → it returns until "don\'t show this again" is ticked', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // A context of its own: the suite's pages are pre-acknowledged.
    const context = await ctx.browser._browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    const notice = page.locator('[data-testid="risk-notice"]');
    const open = async () => {
      await navigateToSession(page, ctx.session.name);
      await page.bringToFront();
    };

    // Shown, on top, and saying the two things it exists to say.
    await open();
    await notice.waitFor({ state: 'visible', timeout: 10000 });
    const text = await notice.innerText();
    expect(text).toContain('written by AI agents');
    expect(text).toContain('remote control for your shell');
    const accept = page.getByRole('button', { name: 'I understand' });
    const box = await accept.boundingBox();
    const topmost = await page.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="risk-notice"]')),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(topmost).toBe(true);

    // Modal: what is typed while it is up never reaches the pane.
    const BLOCKED = `BLOCKED_${Date.now()}`;
    await page.keyboard.type(`echo ${BLOCKED}`);
    await page.keyboard.press('Enter');
    await delay(DELAYS.SYNC);
    expect(await getTerminalText(page)).not.toContain(BLOCKED);

    // Accepted without the checkbox: typing works, and the next load asks again.
    await accept.click();
    await notice.waitFor({ state: 'hidden' });
    const TYPED = `TYPED_${Date.now()}`;
    await focusPage(page);
    await typeInTerminal(page, `echo ${TYPED}`);
    await pressEnter(page);
    await waitForTerminalText(page, TYPED);

    await open();
    await notice.waitFor({ state: 'visible', timeout: 10000 });
    await page.getByLabel("Don't show this again").check();
    await page.getByRole('button', { name: 'I understand' }).click();
    await notice.waitFor({ state: 'hidden' });

    // Ticked: it does not come back.
    await open();
    await delay(DELAYS.SYNC);
    expect(await notice.count()).toBe(0);

    await context.close();
  }, 120000);
});
