/**
 * `tmuxy pane send -t` into another pane — the keys go once the user allows it.
 *
 * The whole round trip, through the real chain: the CLI typed into a real
 * shell, the `@tmuxy-ask` option on a real tmux server, the question drawn
 * over the target pane, the answer given from the keyboard in the SENDING
 * pane or by a click, and the keys finally landing in the target (or not).
 *
 * This is the shape of the use case the permission exists for: an agent runs
 * in one pane and types into the pane beside it; the user reads what it wants
 * to send and allows it without leaving the agent's pane.
 */

const path = require('path');
const {
  createTestContext,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  waitForShellPrompt,
  splitPaneKeyboard,
  waitForPaneCount,
  waitForCondition,
} = require('./helpers');

const TMUXY_CLI = path.resolve(__dirname, '../packages/tmuxy-cli/bin/tmuxy-cli');

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

/** Run a command line in a pane, giving it the keyboard first. */
async function typeCommand(page, paneId, line) {
  await typeInTerminal(page, line, { target: `[data-pane-id="${paneId}"] [role="log"]` });
  await pressEnter(page);
}

/** What a pane's terminal shows. */
async function screenOf(page, paneId) {
  return page.evaluate(
    (id) => document.querySelector(`[data-pane-id="${id}"] [role="log"]`)?.textContent ?? '',
    paneId,
  );
}

/**
 * The question drawn over a pane, once it is really on screen: in the DOM is
 * not enough — an overlay clipped to nothing is an unanswerable question.
 */
async function waitForAskOverlay(page, paneId, sendingPaneId, timeout = 20000) {
  let why = 'it never appeared';
  return waitForCondition(
    page,
    async () => {
      const seen = await page.evaluate((id) => {
        const el = document.querySelector(`[data-pane-ask="${id}"]`);
        if (!el) return null;
        const box = (sel) => {
          const r = el.querySelector(sel)?.getBoundingClientRect();
          return r ? { top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
        };
        const pane = el.getBoundingClientRect();
        return {
          selected: el.getAttribute('data-ask-selected'),
          questions: [...el.querySelectorAll('.ask-overlay-question')].map((q) => q.textContent),
          caller: el.querySelector('.ask-overlay-caller')?.textContent ?? '',
          pane: { top: pane.top, bottom: pane.bottom },
          text: box('.ask-overlay-text'),
          answers: box('.ask-overlay-choices'),
          block: box('.ask-overlay-command-block'),
        };
      }, paneId);
      if (seen?.text && seen.text.width >= 40 && seen.text.height >= 20) return seen;
      if (seen) why = `its text is ${seen.text?.width}x${seen.text?.height} — not readable`;
      return null;
    },
    timeout,
    // The sending pane's own screen is the only place that says WHY: a CLI
    // that refused the arguments, a shell that never found it, a question
    // still waiting on a sync. Without it the failure is just "nothing
    // appeared".
    async () =>
      `the ask overlay on ${paneId} to be visible (${why}). ` +
      `The sending pane (${sendingPaneId}) shows: ${JSON.stringify((await screenOf(page, sendingPaneId)).slice(-600))}`,
  );
}

async function waitForNoAskOverlay(page, paneId) {
  await waitForCondition(
    page,
    () => page.evaluate((id) => document.querySelector(`[data-pane-ask="${id}"]`) === null, paneId),
    15000,
    'the answered question to leave the screen',
  );
}

/** The state mark a pane's header shows, if it is drawn. */
async function headerMark(page, paneId) {
  return page.evaluate((id) => {
    const mark = document.querySelector(`[data-pane-tab="${id}"] .pane-state-mark`);
    const box = mark?.getBoundingClientRect();
    if (!mark || !box || box.width === 0) return null;
    return [...mark.classList].find((c) => c.startsWith('is-'))?.slice(3) ?? null;
  }, paneId);
}

describe('Scenario: tmuxy pane send asks before typing into another pane', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** Two shells side by side, the keyboard in the first. */
  async function twoPanes() {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    await waitForShellPrompt(ctx.page);
    const panes = await panesOfTab(ctx.page);
    expect(panes.there).toBeTruthy();
    expect(panes.here).not.toBe(panes.there);
    return panes;
  }

  test('a send into the pane beside you is allowed with Cmd+Enter, a second one declined with a click, a long one shown whole', async () => {
    if (ctx.skipIfNotReady()) return;
    const { page } = ctx;
    const { here, there } = await twoPanes();
    const targetScope = `[data-pane-id="${there}"]`;

    // 1. Allowed. Typed, not injected: the send runs in a shell, the way an
    //    agent runs it, and the whole path from that shell to the overlay is
    //    what this is about.
    await typeCommand(page, here, `${TMUXY_CLI} pane send -t ${there} 'echo send-allowed' Enter`);
    let overlay = await waitForAskOverlay(page, there, here);
    expect(overlay.caller).toBeTruthy();
    expect(overlay.questions).toEqual([`${overlay.caller} wants to send echo send-allowed.Allow?`]);
    expect(overlay.block).toBeNull();
    // Yes is highlighted before anything is touched — the same answer the
    // shortcut gives, so what the user sees and what the shortcut does agree.
    expect(overlay.selected).toBe('yes');
    // The sending pane says it is waiting on the user while the question is up.
    await waitForCondition(
      page,
      async () => (await headerMark(page, here)) === 'needs-input',
      10000,
      'the sending pane to show it needs input',
    );
    // Nothing has been sent yet: that is the point of asking.
    expect(await screenOf(page, there)).not.toContain('send-allowed');

    // Answer from where the user already is; the keyboard never moves.
    const accelerator = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(accelerator);
    await page.keyboard.press('Enter');
    await page.keyboard.up(accelerator);
    await waitForNoAskOverlay(page, there);
    await waitForTerminalText(page, 'send-allowed', 20000, {
      scope: targetScope,
      notOnLineWith: 'echo send',
    });
    expect((await panesOfTab(page)).here).toBe(here);
    // The sender is free again, says what it sent, and is no longer waiting.
    await waitForTerminalText(page, `sent to ${there}`, 15000, {
      scope: `[data-pane-id="${here}"]`,
    });
    await waitForCondition(
      page,
      async () => (await headerMark(page, here)) !== 'needs-input',
      10000,
      'the sending pane to stop waiting on the user',
    );

    // 2. Declined with a click on "2. No": nothing lands.
    await typeCommand(page, here, `${TMUXY_CLI} pane send -t ${there} 'echo send-declined' Enter`);
    await waitForAskOverlay(page, there, here);
    await page.click(`[data-pane-ask="${there}"] [data-ask-choice="no"]`);
    await waitForNoAskOverlay(page, there);
    await waitForTerminalText(page, 'nothing sent', 15000, { scope: `[data-pane-id="${here}"]` });
    expect(await screenOf(page, there)).not.toContain('send-declined');

    // 3. A long, multi-line send: its own block, scrolling, with the question
    //    and the answers still inside the pane. Each line is twice the
    //    70ch the text is capped at, so it scrolls sideways at any window size.
    await typeCommand(
      page,
      here,
      `a=(); for i in $(seq 12); do a+=("echo line-$i-of-a-long-send-$(printf %0140d 0)" Enter); done; ${TMUXY_CLI} pane send -t ${there} "\${a[@]}"`,
    );
    overlay = await waitForAskOverlay(page, there, here);
    expect(overlay.questions).toEqual([`${overlay.caller} wants to send:`, 'Allow?']);
    expect(overlay.block).not.toBeNull();
    const scroll = await page.evaluate((id) => {
      const block = document.querySelector(`[data-pane-ask="${id}"] .ask-overlay-command-block`);
      return {
        text: block.textContent,
        down: block.scrollHeight > block.clientHeight,
        across: block.scrollWidth > block.clientWidth,
      };
    }, there);
    expect(scroll.text).toContain('line-12-of-a-long-send');
    expect(scroll.down).toBe(true);
    expect(scroll.across).toBe(true);
    for (const part of [overlay.text, overlay.answers]) {
      expect(part.top).toBeGreaterThanOrEqual(overlay.pane.top);
      expect(part.bottom).toBeLessThanOrEqual(overlay.pane.bottom);
    }
    await page.click(`[data-pane-ask="${there}"] [data-ask-choice="no"]`);
    await waitForNoAskOverlay(page, there);
  }, 180000);

  test('@tmuxy-send-ask off and @tmuxy-send-allow skip the question, and the target is left unread', async () => {
    if (ctx.skipIfNotReady()) return;
    const { page } = ctx;
    const { here, there } = await twoPanes();
    const targetScope = `[data-pane-id="${there}"]`;

    try {
      // Off: the keys go at once, the pane is marked unread. The switches are
      // the user's to set (tmux.conf, the command prompt); `tmuxy run`
      // refuses them, so an agent cannot turn its own question off.
      ctx.session.runAsOperator('set -g @tmuxy-send-ask off');
      await typeCommand(page, here, `${TMUXY_CLI} pane send -t ${there} 'echo sent-unasked' Enter`);
      await waitForTerminalText(page, 'sent-unasked', 20000, {
        scope: targetScope,
        notOnLineWith: 'echo sent',
      });
      expect(await page.$(`[data-pane-ask="${there}"]`)).toBeNull();
      await waitForCondition(
        page,
        async () => (await headerMark(page, there)) === 'unread',
        10000,
        'the target pane to show it has unread output',
      );

      // Looking at it reads it.
      await page.click(`${targetScope} [role="log"]`);
      await waitForCondition(
        page,
        async () => (await headerMark(page, there)) === null,
        10000,
        'the unread mark to go once the pane is in front',
      );

      // Back on, with the target on the allow list: still no question.
      ctx.session.runAsOperator('set -g @tmuxy-send-ask on');
      ctx.session.runAsOperator(`set -g @tmuxy-send-allow ${there}`);
      await typeCommand(
        page,
        here,
        `${TMUXY_CLI} pane send -t ${there} 'echo sent-allowed-list' Enter`,
      );
      await waitForTerminalText(page, 'sent-allowed-list', 20000, {
        scope: targetScope,
        notOnLineWith: 'echo sent',
      });
      expect(await page.$(`[data-pane-ask="${there}"]`)).toBeNull();
    } finally {
      // Global options outlive the test on the shared server.
      ctx.session.runAsOperator('set -gu @tmuxy-send-allow');
      ctx.session.runAsOperator('set -g @tmuxy-send-ask on');
    }
  }, 180000);
});
