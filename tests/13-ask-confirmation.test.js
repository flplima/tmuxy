/**
 * `tmuxy ask` — sending keys to another pane, once the user has agreed.
 *
 * The whole round trip, through the real chain: the CLI typed into a real
 * shell, the `@tmuxy-ask` option on a real tmux server, the overlay drawn over
 * the target pane, the answer given from the keyboard in the OTHER pane, and
 * the keys finally landing in the target.
 *
 * This is the shape of the use case the command exists for: an agent runs in
 * one pane and asks the pane beside it to run something; the user reads the
 * question and agrees without ever leaving the agent's pane.
 */

const path = require('path');
const {
  createTestContext,
  delay,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  waitForShellPrompt,
  splitPaneKeyboard,
  waitForPaneCount,
  waitForCondition,
  DELAYS,
} = require('./helpers');

const TMUXY_CLI = path.resolve(__dirname, '../bin/tmuxy-cli');

/** The pane that holds the keyboard, and the other pane of the tab. */
async function panesOfTab(page) {
  return page.evaluate(() => {
    const { panes, activePaneId, activeWindowId } = window.app.getSnapshot().context;
    const here = panes.find((p) => p.tmuxId === activePaneId);
    const inTab = panes.filter((p) => p.windowId === (here?.windowId ?? activeWindowId));
    return {
      here: activePaneId,
      there: inTab.find((p) => p.tmuxId !== activePaneId)?.tmuxId ?? null,
    };
  });
}

/**
 * The question drawn over a pane, once it is really on screen: in the DOM is
 * not enough — an overlay clipped to nothing is an unanswerable question.
 */
async function waitForAskOverlay(page, paneId, askingPaneId, timeout = 20000) {
  const start = Date.now();
  let why = 'it never appeared';
  while (Date.now() - start < timeout) {
    const seen = await page.evaluate((id) => {
      const el = document.querySelector(`[data-pane-ask="${id}"]`);
      if (!el) return null;
      const card = el.querySelector('.ask-overlay-card');
      const cardBox = card?.getBoundingClientRect();
      return {
        selected: el.getAttribute('data-ask-selected'),
        question: el.querySelector('.ask-overlay-question')?.textContent ?? '',
        description: el.querySelector('.ask-overlay-description')?.textContent ?? '',
        cardWidth: cardBox?.width ?? 0,
        cardHeight: cardBox?.height ?? 0,
      };
    }, paneId);
    if (seen && seen.cardWidth >= 40 && seen.cardHeight >= 20) return seen;
    if (seen) why = `its card is ${seen.cardWidth}x${seen.cardHeight} — not readable`;
    await delay(100);
  }
  // The asking pane's own screen is the only place that says WHY: a CLI that
  // refused the arguments, a shell that never found it, a question still
  // waiting on a sync. Without it the failure is just "nothing appeared".
  const asking = await page.evaluate(
    (id) => document.querySelector(`[data-pane-id="${id}"] [role="log"]`)?.textContent ?? '',
    askingPaneId,
  );
  throw new Error(
    `the ask overlay on ${paneId} never became visible (${why}). ` +
      `The asking pane (${askingPaneId}) shows: ${JSON.stringify(asking.slice(-600))}`,
  );
}

describe('Scenario: tmuxy ask confirms before sending keys to another pane', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a question asked of the pane beside you is agreed to with Cmd+Enter, and the keys land there', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    await waitForShellPrompt(ctx.page);

    const { here, there } = await panesOfTab(ctx.page);
    expect(there).toBeTruthy();
    expect(here).not.toBe(there);

    // The ask runs in the pane holding the keyboard — the agent's — and blocks
    // there. Typed, not injected: `tmuxy ask` is a command a user (or their
    // agent) runs in a shell, and the whole path from that shell to the
    // overlay is what this is about.
    await typeInTerminal(
      ctx.page,
      `${TMUXY_CLI} ask ${there} 'echo ask-confirmed' Enter --description 'Prints a word in the other pane.'`,
    );
    await pressEnter(ctx.page);

    const overlay = await waitForAskOverlay(ctx.page, there, here);
    expect(overlay.question).toContain('echo ask-confirmed');
    expect(overlay.description).toBe('Prints a word in the other pane.');
    // Yes is highlighted before anything is touched — the same answer the
    // shortcut gives, so what the user sees and what the shortcut does agree.
    expect(overlay.selected).toBe('yes');

    // Nothing has been sent yet: that is the point of asking.
    const targetScope = `[data-pane-id="${there}"]`;
    const beforeAnswer = await ctx.page.evaluate(
      (sel) => document.querySelector(`${sel} [role="log"]`)?.textContent ?? '',
      targetScope,
    );
    expect(beforeAnswer).not.toContain('ask-confirmed');

    // Answer from where the user already is. The keyboard never moves to the
    // pane being asked — it is still the asking pane's.
    const snapshotBefore = await panesOfTab(ctx.page);
    expect(snapshotBefore.here).toBe(here);
    const accelerator = process.platform === 'darwin' ? 'Meta' : 'Control';
    await ctx.page.keyboard.down(accelerator);
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up(accelerator);

    // The question comes down...
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          (id) => document.querySelector(`[data-pane-ask="${id}"]`) === null,
          there,
        ),
      15000,
      'the answered question to leave the screen',
    );

    // ...and the keys the question was about land in the other pane.
    await waitForTerminalText(ctx.page, 'ask-confirmed', 20000, { scope: targetScope });

    // The keyboard stayed put throughout.
    expect((await panesOfTab(ctx.page)).here).toBe(here);

    // And the asking pane's own shell is free again — `tmuxy ask` exits once
    // it has sent the keys, which is how its caller knows when to capture.
    await waitForTerminalText(ctx.page, 'yes', 15000, { scope: `[data-pane-id="${here}"]` });
    await delay(DELAYS.SHORT);
  }, 120000);
});
