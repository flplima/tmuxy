/**
 * Input & Interaction E2E Tests (Mouse Selection & Scrollback Clipboard)
 */

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

// ==================== Scenario 7d: Selecting and copying with the mouse ====================

describe('Scenario 7d: Selecting and copying with the mouse', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a drag selects text on the live screen and copies it at once, with a notice of how many characters; the next key clears the selection and is typed', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // 1. The drag itself. The pane used to focus the hidden keyboard input on
    //    the press, which collapses the page's selection, so it selected nothing.
    //    Output that arrives while the text is selected must not slide other
    //    text under the highlight: a job prints after the drag, in the shell
    //    itself, with nothing typed. It prints on a signal — a flag file the
    //    test drops once the selection is in place — not on a clock: a `sleep`
    //    raced the drag on a slow runner, and the output was on screen before
    //    there was a selection for it to slide under.
    //    (printf, so the typed command line does not itself contain the marker.)
    const flag = path.join(os.tmpdir(), `tmuxy-late-output-${process.pid}-${Date.now()}`);
    await runCommand(
      ctx.page,
      `( while [ ! -e ${flag} ]; do sleep 0.1; done; seq 1 5; printf 'LATE_%s\\n' OUTPUT ) &`,
      '[1]',
    );
    await runCommand(ctx.page, 'echo "DRAG_SELECT_ME and more"', 'DRAG_SELECT_ME');
    const at = await shownRunRect(ctx.page, '.pane-layout-item', 'DRAG_SELECT_ME');
    await recordCopies(ctx.page);
    // Every blink box as it is added: the blink outlasts no poll.
    await ctx.page.evaluate(() => {
      window.__flashes = 0;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.classList?.contains('copy-flash')) window.__flashes += 1;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await dragSelect(ctx.page, at);
    expect(await selectedText(ctx.page)).toBe('DRAG_SELECT_ME');

    // Copy on select: the release itself put the text on the clipboard and
    // the snackbar says how many characters went; the selection stays.
    await waitForCondition(
      ctx.page,
      () => copiedText(ctx.page).then((text) => text === 'DRAG_SELECT_ME'),
      5000,
      'the release to copy the selection',
    );
    const notice = await ctx.page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="snackbar-item"]')].find((n) =>
        n.textContent.includes('Copied'),
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent,
        role: el.getAttribute('role'),
        width: r.width,
        height: r.height,
      };
    });
    expect(notice).not.toBeNull();
    expect(notice.text).toContain('Copied 14 characters');
    expect(notice.role).toBe('status');
    expect(notice.width).toBeGreaterThan(0);
    expect(notice.height).toBeGreaterThan(0);
    expect(await selectedText(ctx.page)).toBe('DRAG_SELECT_ME');
    // The notice is the sign: selecting does not blink the text.
    expect(await ctx.page.evaluate(() => window.__flashes)).toBe(0);

    // The job has printed in tmux; the pane on screen holds still, the
    // selection still reads the same text, and it still sits on the same row.
    fs.writeFileSync(flag, '');
    const paneId = await ctx.session.getActivePaneId();
    await waitForCondition(
      ctx.page,
      async () => tmuxExec(`capture-pane -t ${paneId} -p`).includes('LATE_OUTPUT'),
      10000,
      'the background job to print in tmux',
    );
    await delay(DELAYS.SHORT);
    expect(await getTerminalText(ctx.page)).not.toContain('LATE_OUTPUT');
    expect(await selectedText(ctx.page)).toBe('DRAG_SELECT_ME');
    const still = await runRect(ctx.page, '.pane-layout-item', 'DRAG_SELECT_ME');
    expect(Math.abs(still.box.top - at.box.top)).toBeLessThanOrEqual(1);

    // The selection is a wash of the theme's foreground over its background,
    // under text that keeps its own colour.
    const paint = await ctx.page.evaluate(() => {
      const node = window.getSelection().getRangeAt(0).startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      const sel = getComputedStyle(el, '::selection');
      const probe = document.createElement('span');
      probe.style.backgroundColor =
        'color-mix(in srgb, var(--term-foreground) 32%, var(--term-background))';
      document.body.appendChild(probe);
      const result = {
        bg: sel.backgroundColor,
        fg: sel.color,
        wantBg: getComputedStyle(probe).backgroundColor,
        ownFg: getComputedStyle(el).color,
      };
      probe.remove();
      return result;
    });
    expect(paint.wantBg).not.toBe('rgba(0, 0, 0, 0)');
    expect({ bg: paint.bg, fg: paint.fg }).toEqual({ bg: paint.wantBg, fg: paint.ownFg });

    // 2. Cmd+C copies the same text once more and blinks it: boxes laid over
    //    the selection, which go away on their own.
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
    expect(await copiedText(ctx.page)).toBe('DRAG_SELECT_ME');
    // Cmd+C was a key: the selection is gone, the text still on the clipboard,
    // and with the selection gone the pane catches up with the job's output.
    expect(await selectedText(ctx.page)).toBe('');
    await waitForTerminalText(ctx.page, 'LATE_OUTPUT');
    fs.rmSync(flag, { force: true });

    // A selection, then typing: the first key clears it and every key is
    // typed, so the command runs as if nothing had been selected.
    await runCommand(ctx.page, 'echo "TYPE_OVER_ME"', 'TYPE_OVER_ME');
    const over = await shownRunRect(ctx.page, '.pane-layout-item', 'TYPE_OVER_ME');
    await dragSelect(ctx.page, over);
    expect(await selectedText(ctx.page)).toBe('TYPE_OVER_ME');
    await ctx.page.keyboard.type('echo TYPED_AFTER');
    expect(await selectedText(ctx.page)).toBe('');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'TYPED_AFTER', 15000, { notOnLineWith: 'echo' });
    expect(await copiedText(ctx.page)).toBe('TYPE_OVER_ME');

    // 3. A row of differently-coloured runs copies as one line. Each run is its
    //    own box, and the browser's own copy broke the line at every one.
    await runCommand(ctx.page, 'printf "\\033[31mRED_RUN\\033[0m PLAIN_RUN\\n"', 'PLAIN_RUN');
    const mixed = await shownRunRect(ctx.page, '.pane-layout-item', 'RED_RUN PLAIN_RUN');
    await dragSelect(ctx.page, mixed);
    await ctx.page.keyboard.press('Meta+c');
    await waitForCondition(
      ctx.page,
      () => copiedText(ctx.page).then((text) => text === 'RED_RUN PLAIN_RUN'),
      5000,
      async () =>
        `Cmd+C to copy the row as one line (copied: ${JSON.stringify(await copiedText(ctx.page))})`,
    );
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // 4. Across rows, the selection is drawn as a terminal draws it: the
    //    first row from where it starts to the pane's edge, an empty row in
    //    the middle across its whole width, the last row up to where it ends.
    //    The markers are this run's own: the drag aims at the first match on
    //    screen, so an earlier run's rows still showing must not match.
    const rows = `ROWS${Date.now().toString(36)}`;
    await runCommand(
      ctx.page,
      `printf '${rows}_%s\\n\\n${rows}_%s\\n' ONE_A THREE_B`,
      `${rows}_THREE_B`,
    );
    const one = await shownRunRect(ctx.page, '.pane-layout-item', `${rows}_ONE_A`);
    const three = await shownRunRect(ctx.page, '.pane-layout-item', `${rows}_THREE_B`);
    await dragSelect(ctx.page, one, { last: three.first + 40, y: three.y });
    let fills = null;
    await waitForCondition(
      ctx.page,
      async () => {
        fills = await ctx.page.evaluate((rows) => {
          const lines = [...document.querySelectorAll('.pane-layout-item .terminal-line')];
          const last = (needle) =>
            lines.filter((l) => (l.textContent || '').startsWith(needle)).pop();
          const first = last(`${rows}_ONE_A`);
          const end = last(`${rows}_THREE_B`);
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
          return {
            first: fill(first),
            empty: fill(empty),
            end: fill(end),
            selection: window.getSelection()?.toString() ?? '',
          };
        }, rows);
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

  test('Ctrl+Shift+C copies a drag selection and leaves the running program alone', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // `cat` runs until it reads Ctrl+C or end of input, and echoes each line
    // it is given: a line typed after the copy that comes back twice is a cat
    // still running, the way a terminal emulator leaves it.
    await runCommand(ctx.page, 'echo "CTRL_SHIFT_PICK and more"', 'CTRL_SHIFT_PICK');
    await typeInTerminal(ctx.page, 'cat');
    await pressEnter(ctx.page);
    await dragSelect(
      ctx.page,
      await shownRunRect(ctx.page, '.pane-layout-item', 'CTRL_SHIFT_PICK'),
    );
    expect(await selectedText(ctx.page)).toBe('CTRL_SHIFT_PICK');

    await recordCopies(ctx.page);
    await ctx.page.keyboard.press('Control+Shift+C');
    await waitForCondition(
      ctx.page,
      async () => (await copiedText(ctx.page)) !== null,
      5000,
      'Ctrl+Shift+C to copy the selection',
    );
    expect(await copiedText(ctx.page)).toBe('CTRL_SHIFT_PICK');

    await typeInTerminal(ctx.page, 'CAT_STILL_HERE');
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () =>
        (await getTerminalText(ctx.page))
          .split('\n')
          .filter((line) => line.trim() === 'CAT_STILL_HERE').length === 2,
      10000,
      async () =>
        `cat to echo the line back (screen: ${JSON.stringify(await getTerminalText(ctx.page))})`,
    );
    await ctx.page.keyboard.press('Control+d');
    await runCommand(ctx.page, 'echo AFTER_CAT', 'AFTER_CAT');
  }, 60000);

  test('in copy mode a drag copies on release, blinks, and leaves copy mode', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await runCommand(ctx.page, 'echo "COPY_DRAG_ME and more"', 'COPY_DRAG_ME');
    const cs = await enterCopyModeAndWait(ctx.page);
    expect(cs.mode).toBe('copy');
    await ctx.page.evaluate(() => {
      delete window.__tmuxyLastClipboard;
    });

    const at = await runRect(ctx.page, '[data-copy-mode="true"]', 'COPY_DRAG_ME');
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
    await afterFrames(ctx.page, 2);
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
      const wash = 'color-mix(in srgb, var(--term-foreground) 32%, var(--term-background))';
      probe.style.backgroundImage = `linear-gradient(${wash}, ${wash})`;
      probe.style.color = 'var(--term-foreground)';
      document.body.appendChild(probe);
      const got = getComputedStyle(cell);
      const want = getComputedStyle(probe);
      const result = {
        bg: got.backgroundImage,
        fg: got.color,
        wantBg: want.backgroundImage,
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
