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
