/**
 * Input & Interaction E2E Tests (Layout, Keyboard Basics, Paste, International Input, Multi-Viewport)
 */

const {
  createTestContext,
  delay,
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
  DELAYS,
  assertContentMatch,
  assertLayoutInvariants,
  waitForCondition,
  pasteText,
} = require('./helpers');

const BRACKETED_PASTE_SCRIPT = require('path').join(__dirname, 'helpers', 'bracketed-paste.py');

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

    // Step 1b: Verify typing works in the new pane immediately after split.
    // This catches output being dropped by panes_moved_window suppression.
    const SPLIT_TOKEN = 'SPLIT_VIS_' + Date.now();
    await runCommand(ctx.page, `echo ${SPLIT_TOKEN}`, SPLIT_TOKEN);

    // Step 2: Split horizontal (prefix + ") → 3 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3, 10000);

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
    // Keys reach tmux in the order they are pressed, so the two Backspaces
    // need no beat between them.
    await typeInTerminal(ctx.page, 'echo helloxx');
    await ctx.page.keyboard.press('Backspace');
    await ctx.page.keyboard.press('Backspace');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'hello');

    // Step 3: Tab completion — the rest of the line is typed once the shell
    // has completed the word, which is what it would otherwise race. Read up
    // to the cursor: an autosuggesting shell draws a past command after it.
    await typeInTerminal(ctx.page, 'ech');
    await ctx.page.keyboard.press('Tab');
    await ctx.session.waitForCursorLine(/echo$/, 10000, { upToCursor: true });
    await typeInTerminal(ctx.page, ' tab_complete_test');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'tab_complete_test');

    // Step 4: Ctrl+C interrupts — once `sleep` is actually running.
    await typeInTerminal(ctx.page, 'sleep 100');
    await pressEnter(ctx.page);
    await ctx.session.waitForForeground('sleep');
    await sendKeyCombo(ctx.page, 'Control', 'c');
    await waitForShellPrompt(ctx.page);
    await runCommand(ctx.page, 'echo "after_interrupt"', 'after_interrupt');

    // Step 5: Ctrl+D sends EOF — to a `cat` that is up and reading.
    await typeInTerminal(ctx.page, 'cat');
    await pressEnter(ctx.page);
    await ctx.session.waitForForeground('cat');
    await typeInTerminal(ctx.page, 'test_input');
    await pressEnter(ctx.page);
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

  test('a paste longer than one chunk, and quotes, $, # and ; inside one, reach the shell verbatim', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await focusPage(ctx.page);

    // 1200 characters, more than the 500 a paste is staged in at a time, in
    // distinct four-digit blocks: the shell compares what it was given with
    // the same blocks built locally, so a chunk dropped, repeated or out of
    // order fails the comparison and prints nothing.
    const blocks = Array.from({ length: 300 }, (_, i) => String(i).padStart(4, '0')).join('');
    await pasteText(
      ctx.page,
      `x=${blocks}; [ "$x" = "$(seq -f %04g 0 299 | tr -d '\\n')" ] && echo LONG_OK_\${#x}`,
    );
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'LONG_OK_1200');

    // A quote ends tmux's own quoting, `$` must reach the shell unexpanded,
    // `#{…}` is a format tmux would expand, and `;` / `\;` separate tmux
    // commands: each has to arrive as the character it is.
    await pasteText(ctx.page, `echo "it's \\$x #{session_name} ; a\\;b done_QS9"`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, "it's $x #{session_name} ; a\\;b done_QS9");
  }, 60000);

  test('a multi-line paste reaches a bracketed-paste program as ONE paste, not a Return per line', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await focusPage(ctx.page);

    // A program that turned bracketed paste on (`?2004h`), as shells, editors
    // and agents' TUIs do. Typed a line at a time, a paste reached it as
    // `line one` + Return — the TUI submitted the first line and took the rest
    // as fresh input.
    await typeInTerminal(ctx.page, `clear; python3 ${BRACKETED_PASTE_SCRIPT}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'READY');

    await pasteText(ctx.page, 'line one\nline two\nline three');
    await waitForTerminalText(ctx.page, 'PASTED:line one|line two|line three');
    expect(await getTerminalText(ctx.page)).not.toContain('SUBMITTED:');
    await waitForShellPrompt(ctx.page);
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

// ==================== Scenario 23: Multi-Viewport Layout ====================

describe('Scenario 23: Multi-Viewport Layout', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('3 panes → layout invariants at 3 viewport sizes [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create 3-pane layout: vertical split + horizontal split
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3, 10000);

    // Verify invariants at default size first (before any viewport changes)
    await assertLayoutInvariants(ctx.page, { label: 'viewport default (1280x720)' });

    const viewports = [
      { width: 800, height: 600, label: 'small' },
      { width: 1920, height: 1080, label: 'large' },
    ];
    const paneGrid = () =>
      ctx.page.evaluate(() =>
        JSON.stringify(
          (window.app?.getSnapshot()?.context?.panes ?? []).map((p) => [p.width, p.height]),
        ),
      );

    for (const vp of viewports) {
      const before = await paneGrid();
      await ctx.page.setViewportSize({ width: vp.width, height: vp.height });
      // The resize goes browser → server → tmux → browser; it has arrived when
      // tmux's pane sizes have changed.
      await waitForCondition(
        ctx.page,
        async () => (await paneGrid()) !== before,
        10000,
        `tmux to resize the panes for the ${vp.label} viewport`,
      );

      // Wait for pane count to still be 3 after resize
      await waitForPaneCount(ctx.page, 3, 10000);

      await assertLayoutInvariants(ctx.page, {
        label: `viewport ${vp.label} (${vp.width}x${vp.height})`,
      });
    }

    // Restore default viewport
    await ctx.page.setViewportSize({ width: 1280, height: 720 });
  }, 180000);
});
