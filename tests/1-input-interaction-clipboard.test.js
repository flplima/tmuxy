/**
 * Input & Interaction E2E Tests (Mouse Selection & Scrollback Clipboard)
 */

const {
  createTestContext,
  delay,
  focusPage,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  DELAYS,
  assertContentMatch,
  getCopyModeState,
  waitForCondition,
  waitForCopyMode,
  enterCopyModeAndWait,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

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

  /**
   * `cellsOf` once a line starting with `text` is on screen. runCommand's text
   * wait is met by the typed command line, which merely CONTAINS the marker;
   * the output line that starts with it can still be on its way.
   */
  const shownCellsOf = async (page, rootSelector, text) => {
    let found = null;
    await waitForCondition(
      page,
      async () => (found = await cellsOf(page, rootSelector, text)) !== null,
      10000,
      `a line starting with ${text}`,
    );
    return found;
  };

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
    //    Output that arrives while the text is selected must not slide other
    //    text under the highlight: a job prints after the drag, in the shell
    //    itself, with nothing typed.
    //    (printf, so the typed command line does not itself contain the marker.)
    await runCommand(ctx.page, "( sleep 2; seq 1 5; printf 'LATE_%s\\n' OUTPUT ) &", '[1]');
    await runCommand(ctx.page, 'echo "DRAG_SELECT_ME and more"', 'DRAG_SELECT_ME');
    const at = await shownCellsOf(ctx.page, '.pane-layout-item', 'DRAG_SELECT_ME');
    await drag(ctx.page, at.first, at.last, at.y);
    const selected = await ctx.page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected).toBe('DRAG_SELECT_ME');

    // The job has printed in tmux; the pane on screen holds still, the
    // selection still reads the same text, and it still sits on the same row.
    const paneId = await ctx.session.getActivePaneId();
    await waitForCondition(
      ctx.page,
      async () => tmuxExec(`capture-pane -t ${paneId} -p`).includes('LATE_OUTPUT'),
      10000,
      'the background job to print in tmux',
    );
    await delay(DELAYS.SHORT);
    expect(await getTerminalText(ctx.page)).not.toContain('LATE_OUTPUT');
    expect(await ctx.page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(
      'DRAG_SELECT_ME',
    );
    const still = await cellsOf(ctx.page, '.pane-layout-item', 'DRAG_SELECT_ME');
    expect(Math.abs(still.box.top - at.box.top)).toBeLessThanOrEqual(1);

    // The selection wears the theme's two colours reversed: its foreground as
    // the ground, its background as the text.
    const paint = await ctx.page.evaluate(() => {
      const node = window.getSelection().getRangeAt(0).startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      const sel = getComputedStyle(el, '::selection');
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--term-foreground)';
      probe.style.color = 'var(--term-background)';
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
    // With the selection gone the pane catches up with the job's output.
    await waitForTerminalText(ctx.page, 'LATE_OUTPUT');

    // 3. A row of differently-coloured runs copies as one line. Each run is its
    //    own box, and the browser's own copy broke the line at every one.
    await runCommand(ctx.page, 'printf "\\033[31mRED_RUN\\033[0m PLAIN_RUN\\n"', 'PLAIN_RUN');
    const mixed = await shownCellsOf(ctx.page, '.pane-layout-item', 'RED_RUN PLAIN_RUN');
    await drag(ctx.page, mixed.first, mixed.last, mixed.y);
    await ctx.page.keyboard.press('Meta+c');
    await waitForCondition(
      ctx.page,
      () => ctx.page.evaluate(() => window.__copied === 'RED_RUN PLAIN_RUN'),
      5000,
      async () =>
        `Cmd+C to copy the row as one line (copied: ${JSON.stringify(
          await ctx.page.evaluate(() => window.__copied),
        )})`,
    );
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // 4. Across rows, the selection is drawn as a terminal draws it: the
    //    first row from where it starts to the pane's edge, an empty row in
    //    the middle across its whole width, the last row up to where it ends.
    await runCommand(ctx.page, "printf 'ROWS_%s\\n\\nROWS_%s\\n' ONE_A THREE_B", 'ROWS_THREE_B');
    const one = await shownCellsOf(ctx.page, '.pane-layout-item', 'ROWS_ONE_A');
    const three = await shownCellsOf(ctx.page, '.pane-layout-item', 'ROWS_THREE_B');
    await ctx.page.mouse.move(one.first, one.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(three.first + 40, three.y, { steps: 10 });
    await ctx.page.mouse.up();
    let fills = null;
    await waitForCondition(
      ctx.page,
      async () => {
        fills = await ctx.page.evaluate(() => {
          const lines = [...document.querySelectorAll('.pane-layout-item .terminal-line')];
          const last = (needle) =>
            lines.filter((l) => (l.textContent || '').startsWith(needle)).pop();
          const first = last('ROWS_ONE_A');
          const end = last('ROWS_THREE_B');
          const empty = lines[lines.indexOf(first) + 1];
          const fill = (row) => {
            const after = getComputedStyle(row, '::after');
            return {
              shown: after.content !== 'none',
              width: parseFloat(after.width) || 0,
              row: row.getBoundingClientRect().width,
              bg: after.backgroundColor,
            };
          };
          return { first: fill(first), empty: fill(empty), end: fill(end) };
        });
        return fills.empty.shown;
      },
      5000,
      () => `the selection to fill the rows it runs past (${JSON.stringify(fills)})`,
    );
    expect(fills.empty.width).toBeGreaterThan(fills.empty.row * 0.95);
    expect(fills.first.width).toBeGreaterThan(0);
    expect(fills.first.width).toBeLessThan(fills.first.row);
    expect(fills.empty.bg).toBe(paint.wantBg);
    expect(fills.end.shown).toBe(false);
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
    // Copy mode's block cursor is the theme's accent, whatever the theme.
    const cursor = await ctx.page.evaluate(() => {
      const shape = document.querySelector('.smooth-cursor.is-copy .smooth-cursor-shape');
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--theme-accent)';
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
      probe.style.color = 'var(--term-background)';
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
