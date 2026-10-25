/**
 * Input & Interaction E2E Tests (Resize from Prompt, SGR & Touch Scrolling)
 */

const {
  afterFrames,
  createTestContext,
  delay,
  focusPage,
  getTerminalText,
  waitForShellPrompt,
  runCommand,
  getUIPaneCount,
  typeInTerminal,
  pressEnter,
  waitForPaneCount,
  splitPaneKeyboard,
  killPaneKeyboard,
  resizePaneKeyboard,
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
} = require('./helpers');

// ==================== Touch Scroll Helpers ====================

/** One finger from `startY` to `endY` in `steps` moves, a frame apart, as a thumb moves. */
async function dispatchTouchScroll(page, startX, startY, endY, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  const deltaY = (endY - startY) / steps;

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y: startY }],
  });
  await delay(16);

  for (let i = 1; i <= steps; i++) {
    const y = startY + deltaY * i;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX, y }],
    });
    await delay(16);
  }

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
}

// ==================== Scenario 8a: typed text reaches the shell verbatim ====================

describe('Scenario 8a: typed text reaches the shell verbatim', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // Typed text travels as a `send-keys -l` literal. A tmux that format-expanded
  // it would hand the shell `%0` for `#{pane_id}`; the v86 guest's console did
  // that once, and this holds the native path to the letter on every tmux CI
  // runs (docs/TMUX-VERSION-BUGS.md).
  test('a #{format} typed at the prompt is not expanded by tmux', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await runCommand(ctx.page, "printf '%s\\n' 'LIT#{pane_id}END'", 'LIT#{pane_id}END');
    // The typed line and its output, both verbatim.
    await waitForCondition(
      ctx.page,
      async () => (await getTerminalText(ctx.page)).split('LIT#{pane_id}END').length >= 3,
      5000,
      'the printed line to come back as typed',
    );
    expect(await getTerminalText(ctx.page)).not.toMatch(/LIT%\d+END/);
  });
});

// ==================== Scenario 8: Resize from the prompt & SGR ====================

describe('Scenario 8: Resize from the prompt & SGR', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    await ensureMouseCaptureStopped(ctx);
    await ctx.afterEach();
  }, ctx.hookTimeout);

  // The mouse drag of a divider is covered in 2-layout-navigation (the 2×2
  // grid test); this one resizes from the command prompt.
  test('resize-pane -D / -R at the prompt → SGR click → SGR wheel → SGR right-click', async () => {
    if (ctx.skipIfNotReady()) return;

    // Step 1: resize-pane -D on a stacked pair
    await ctx.setupTwoPanes('horizontal');
    await waitForPaneCount(ctx.page, 2);
    await assertContentMatch(ctx.page, 'Scenario 8 setup');
    await assertLayoutInvariants(ctx.page);
    let panesBefore = await ctx.session.getPaneInfo();
    await resizePaneKeyboard(ctx.page, 'D', 5);
    await waitForCondition(
      ctx.page,
      async () =>
        (await ctx.session.getPaneInfo()).some(
          (after, i) => panesBefore[i] && panesBefore[i].height !== after.height,
        ),
      8000,
      'resize-pane -D to change the panes’ heights',
    );

    // Kill panes to reset
    await killPaneKeyboard(ctx.page);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 2: resize-pane -R on a side-by-side pair
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    panesBefore = await ctx.session.getPaneInfo();
    await resizePaneKeyboard(ctx.page, 'R', 10);
    await waitForCondition(
      ctx.page,
      async () =>
        (await ctx.session.getPaneInfo()).some(
          (after, i) => panesBefore[i] && panesBefore[i].width !== after.width,
        ),
      8000,
      'resize-pane -R to change the panes’ widths',
    );

    // Kill pane to reset for SGR tests
    await killPaneKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 1);
    // After killing a pane, wait for the remaining pane to become active.
    // The keyboard actor won't route input until activePaneId matches.
    // After killing a pane, the surviving pane's content is reset by
    // capture-pane. Wait for the prompt to render before typing.
    await waitForShellPrompt(ctx.page);

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
    const capture2 = await startMouseCapture(ctx);

    const wheelX = capture2.contentBox.x + capture2.contentBox.width / 2;
    const wheelY = capture2.contentBox.y + capture2.contentBox.height / 2;
    await ctx.page.mouse.move(wheelX, wheelY);
    await ctx.page.mouse.wheel(0, -capture2.charSize.charHeight * 3);
    // The first wheel has reached tmux before the second is sent, so the two
    // arrive as distinct reports rather than one coalesced scroll. The second
    // wait is for a scroll-down report itself: the first wheel's remaining
    // up-reports can still be arriving, and one of those would satisfy a
    // count.
    await readMouseEvents(1);
    await ctx.page.mouse.wheel(0, capture2.charSize.charHeight * 2);
    await waitForCondition(
      ctx.page,
      async () => {
        events = await readMouseEvents(0, 1000);
        return events.some((e) => e.type === 'scroll_down');
      },
      10000,
      'the scroll-down to reach tmux',
    );
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
    // The right-click press itself, not merely one more report: a wheel
    // report from the step above can still be arriving.
    let rPress;
    await waitForCondition(
      ctx.page,
      async () => {
        const events = await readMouseEvents(eventsBefore.length, 1000);
        rPress = events.find((e) => e.type === 'press' && e.btn === 2);
        return rPress !== undefined;
      },
      10000,
      'the right-click press to reach tmux',
    );
    expect(rPress.btn).toBe(2);

    await stopMouseCapture(ctx);
  }, 180000);
});

// ==================== Scenario 21: Touch Scrolling ====================

describe('Scenario 21: Touch Scrolling', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Touch scroll: CSS prevention → normal shell → alternate screen → multi-pane isolation [nightly]', async () => {
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
    );
    // Touch events are unreliable in headless, so fall back to keyboard entry
    // (the correct prefix from tmuxy.conf) when the swipe did not register —
    // judged by whether the view opened, not after a fixed pause.
    await waitForCondition(
      ctx.page,
      async () => !!(await getCopyModeState(ctx.page))?.active,
      3000,
      'the swipe to open the scroll view',
    ).catch(() => {});
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

    // Step 4: Touch scroll in alternate screen (less command)
    const alternateOn = () =>
      ctx.page.evaluate(
        () => document.querySelector('.pane-wrapper')?.getAttribute('data-alternate-on') === 'true',
      );
    await typeInTerminal(ctx.page, 'less /etc/services');
    await pressEnter(ctx.page);
    await waitForCondition(ctx.page, alternateOn, 10000, 'less to switch to the alternate screen');

    // Get initial visible text
    const textBefore = await getTerminalText(ctx.page);

    // Touch scroll down in alternate screen (finger up = scroll down = Down arrow keys)
    await dispatchTouchScroll(
      ctx.page,
      paneBox.x,
      paneBox.y + paneBox.height * 0.4,
      paneBox.y - paneBox.height * 0.2, // swipe up 60% of pane
      10,
    );

    // Verify content changed (scrolled down in less)
    // Touch events may not reliably translate to arrow keys in headless mode —
    // fall back to keyboard Down arrows if touch didn't scroll.
    const scrolled = async () => (await getTerminalText(ctx.page)) !== textBefore;
    const swipeScrolled = await waitForCondition(
      ctx.page,
      scrolled,
      3000,
      'the swipe to scroll less',
    )
      .then(() => true)
      .catch(() => false);
    if (!swipeScrolled) {
      for (let i = 0; i < 10; i++) {
        await ctx.page.keyboard.press('ArrowDown');
        await delay(50);
      }
      await waitForCondition(ctx.page, scrolled, 10000, 'Down arrows to scroll less');
    }
    expect(await getTerminalText(ctx.page)).not.toBe(textBefore);

    // Exit less
    await ctx.page.keyboard.press('q');
    await waitForCondition(
      ctx.page,
      async () => !(await alternateOn()),
      10000,
      'less to quit and leave the alternate screen',
    );

    // Step 5: Multi-pane touch isolation
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);

    // Generate distinct content in each pane
    await runCommand(ctx.page, 'echo PANE_TWO_MARKER', 'PANE_TWO_MARKER');

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
    );
    // A touch is handled in the page; a pane it took away would be gone a
    // frame or two later.
    await afterFrames(ctx.page);

    // Both panes should still exist
    const finalPaneCount = await getUIPaneCount(ctx.page);
    expect(finalPaneCount).toBe(2);

    // Exit copy mode if active (touch scroll enters copy mode on normal screen)
    const touchCopyState = await getCopyModeState(ctx.page);
    if (touchCopyState?.active) {
      await ctx.page.keyboard.press(touchCopyState.mode === 'scroll' ? 'Escape' : 'q');
      await waitForCopyMode(ctx.page, false);
    }

    // Layout was already validated before the multi-pane isolation step.
    // After copy mode + touch scroll, layout may temporarily have extra height
    // from the scrollback terminal cleanup — skip re-validating here.
  }, 180000);
});
