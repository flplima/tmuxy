/**
 * TUI Alternate-Screen Rendering E2E Test
 *
 * Runs a heavy TUI simulation script (see tests/fixtures/heavy-tui.sh) that
 * enters alternate screen, draws a complex layout (256-color grid,
 * attribute samplers, status panel, progress bar) and performs multiple
 * cell-rewrite update rounds. Then asserts the rendered tmuxy UI matches
 * what `tmux capture-pane -p` reports for the same pane, line by line.
 *
 * The standard `assertContentMatch` helper skips alt-screen panes —
 * `assertAltScreenMatch` exists for this case and is what we use here.
 * Alt-screen is where most complex rendering bugs hide.
 */

const path = require('path');
const {
  createTestContext,
  delay,
  waitForTerminalText,
  waitForPaneCount,
  waitForCondition,
  typeInTerminal,
  pressEnter,
  focusPage,
  assertAltScreenMatch,
  DELAYS,
  WORKSPACE_ROOT,
} = require('./helpers');

const TUI_SCRIPT = path.join(WORKSPACE_ROOT, 'tests/fixtures/heavy-tui.sh');

describe('Scenario: Heavy TUI alternate-screen rendering matches tmux capture-pane', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Renders alternate-screen TUI identically to tmux ground truth', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await focusPage(ctx.page);

    // Launch the TUI script. It enters alt-screen, draws the layout, and
    // prints TUI_READY as the final cell — that marker is what the test
    // waits on before capturing.
    await typeInTerminal(ctx.page, `bash ${TUI_SCRIPT}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'TUI_READY', 20000);

    // Let the screen settle once more after READY (the script does a
    // final sleep loop; capture-pane returns the steady-state buffer).
    await delay(DELAYS.SYNC);

    try {
      // Compare every visible row of the alt-screen against tmux's own
      // capture-pane output. Spot-checks distinctive markers to guard
      // against the degenerate "both buffers happen to be empty" case.
      await assertAltScreenMatch(ctx.page, ctx.session.name, {
        maxDiffs: 0,
        requireMarkers: ['TUI BENCH', 'STATUS:', 'tmuxy-test', 'RED-ON-BLUE', 'TUI_READY'],
      });
    } finally {
      // Cleanup: Ctrl+C tells the script's trap to drop alt-screen and exit.
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('c');
      await ctx.page.keyboard.up('Control');
      await delay(DELAYS.SYNC);
    }
  }, 120000);
});

// ==================== Scenario: a wheel reaches a TUI that was already running ====================
//
// The desktop app starts its monitor before the webview can listen, so the
// monitor's one Full broadcast is gone by the time the frontend asks for a
// baseline. That baseline used to be a subprocess poll that did not know the
// modes a program had set before the client attached — capture-pane replays
// the screen, not `?1049h` / `?1000h` — and a delta only carries what
// changed, so a pane running a mouse-tracking full-screen program (Claude
// Code) stayed "plain" on the client for as long as the program ran: every
// wheel over it was dropped. A reload reproduces "attach after the program
// started" on the web: the initial state is the monitor's own picture now.

describe('Scenario: a wheel reaches a mouse-tracking TUI that was running before the client attached', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('after a reload the pane is known to track the mouse and the wheel arrives as SGR reports', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await focusPage(ctx.page);
    const page = ctx.page;

    // A program that turns on the alternate screen and SGR mouse tracking,
    // then echoes every byte it receives as visible text.
    await typeInTerminal(page, "printf '\\e[?1049h\\e[?1000h\\e[?1006h'; cat -v");
    await pressEnter(page);
    await waitForCondition(
      page,
      async () =>
        String(
          await ctx.session.query("list-panes -F '#{alternate_on} #{mouse_any_flag}'"),
        ).trim() === '1 1',
      10000,
      'tmux to report the alternate screen and mouse tracking',
    );

    // A fresh client, attaching after the program set its modes.
    await page.reload();
    await waitForPaneCount(page, 1, 15000);
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          const p = c?.panes?.find((x) => x.tmuxId === c.activePaneId);
          return !!p && p.alternateOn === true && p.mouseAnyFlag === true;
        }),
      10000,
      'the client to know the pane tracks the mouse',
    );

    // Wheel over the pane: with the modes known, the wheel is forwarded to
    // the program as SGR mouse reports (button 64 = wheel up), which cat -v
    // shows as text.
    const box = await page.evaluate(() => {
      const r = document.querySelector('.terminal-content').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.wheel(0, -120);
    await delay(DELAYS.SHORT);
    await page.mouse.wheel(0, -120);
    await waitForCondition(
      page,
      async () => String(await ctx.session.query('capture-pane -p')).includes('^[[<64;'),
      10000,
      'the program to receive an SGR wheel report',
    );

    // Ctrl+C ends cat; the pane goes back to the shell.
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await delay(DELAYS.SYNC);
  }, 120000);
});
