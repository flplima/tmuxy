/**
 * Input & Interaction E2E Tests (Selecting the whole scrollback)
 *
 * Cmd+A / Ctrl+Shift+A select every row of a pane's history, on screen and
 * off, and the copy key takes all of it. The mouse selection and its copy
 * are tests/1-input-interaction-clipboard.test.js.
 */

// ==================== Scenario 7e: Selecting the whole scrollback ====================

const {
  createTestContext,
  delay,
  afterFrames,
  focusPage,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  typeInTerminal,
  pressEnter,
  DELAYS,
  assertContentMatch,
  getCopyModeState,
  waitForCondition,
  waitForCopyMode,
  enterCopyModeAndWait,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');
const {
  runRect,
  shownRunRect,
  dragSelect,
  selectedText,
  recordCopies,
  copiedText,
} = require('./helpers/selection-drag');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Scenario 7e: Selecting the whole scrollback', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test.each([
    { keys: 'Cmd', mod: 'Meta' },
    { keys: 'Ctrl+Shift', mod: 'Control+Shift' },
  ])(
    '$keys+A selects every row of scrollback, on screen and off, and $keys+C copies all of it',
    async ({ mod }) => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();
      await focusPage(ctx.page);

      // History taller than the viewport, so most of what gets selected has no
      // DOM node to select — the point of a client selection over the browser's.
      await runCommand(ctx.page, 'seq 1 300', '300');
      await assertContentMatch(ctx.page, 'Scenario 7e setup');

      // What the copy actually put on the clipboard: read off the copy event,
      // after the app's own handler has set it.
      await recordCopies(ctx.page);

      await ctx.page.keyboard.press(`${mod}+a`);

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

      // The copy key takes every selected row — including the ones far above the
      // viewport, which is the whole reason the copy is read from the loaded
      // rows and not from the document.
      await ctx.page.keyboard.press(`${mod}+c`);
      await waitForCondition(
        ctx.page,
        async () => {
          const text = await copiedText(ctx.page);
          return typeof text === 'string' && text.length > 0;
        },
        15000,
        'the selection to reach the clipboard',
      );
      const copied = await copiedText(ctx.page);
      const lines = copied.split('\n').map((l) => l.trim());
      expect(lines).toContain('1');
      expect(lines).toContain('150');
      expect(lines).toContain('300');

      // The copy ends the view, as a yank does, and the pane is live again.
      await waitForCopyMode(ctx.page, false);
      await runCommand(ctx.page, 'echo SELECT_ALL_OK', 'SELECT_ALL_OK');
      await assertContentMatch(ctx.page, 'Scenario 7e end');
    },
    180000,
  );
});
