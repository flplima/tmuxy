/**
 * Pointer handling over a pane that embeds a page.
 *
 * The `browser` widget puts an `<iframe>` in a pane, and an iframe is a hole in
 * the app's event surface: everything inside it belongs to that document, so
 * the app sees neither the click that should activate the pane nor the
 * `mousemove`/`mouseup` a drag runs on. Both symptoms are what this covers,
 * and both need a REAL pointer over a REAL frame — a synthetic event cannot
 * cross a document boundary, so this cannot live in a Storybook story.
 */

const path = require('path');
const {
  createTestContext,
  delay,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  splitPaneKeyboard,
  waitForPaneCount,
  waitForCondition,
  DELAYS,
} = require('./helpers');

const TMUXY_CLI = path.resolve(__dirname, '..', 'bin/tmuxy-cli');

/** The app's view of its panes: which is active, and how wide each one is. */
function paneState(page) {
  return page.evaluate(() => {
    const { panes, activePaneId, resize } = window.app.getSnapshot().context;
    return {
      activePaneId,
      resizing: resize !== null,
      widths: Object.fromEntries(panes.map((p) => [p.tmuxId, p.width])),
    };
  });
}

/** The centre of the embedded frame, in viewport pixels. */
function frameCentre(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.widget-browser-frame');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
}

describe('Scenario: a pane showing a page still belongs to the app', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('clicking the page activates its pane, and a divider dragged across it keeps following the cursor', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // Side by side (tmux's `%`), so the divider between the panes is the
    // vertical one and dragging it sideways carries the cursor straight across
    // the page — which is the gesture that used to die.
    //
    // The page goes in the pane that does NOT hold the keyboard: the whole
    // question is what happens when you reach for the other one.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await waitForShellPrompt(ctx.page);

    const file = `/tmp/tmuxy-widget-pointer-${Date.now()}.html`;
    await typeInTerminal(
      ctx.page,
      `printf '<body style="background:#123;color:#eee"><h1>PAGE</h1></body>' > ${file}; ` +
        `${TMUXY_CLI} widget browser ${file}`,
    );
    await pressEnter(ctx.page);

    // The frame is really on screen before anything is aimed at it.
    let centre = null;
    await waitForCondition(
      ctx.page,
      async () => {
        centre = await frameCentre(ctx.page);
        return centre !== null;
      },
      30000,
      'the browser widget frame to be drawn with a real box',
    );

    const framePaneId = await ctx.page.evaluate(
      () => document.querySelector('[role=group][aria-label^="Widget pane"]')?.dataset.paneId,
    );
    expect(framePaneId).toBeTruthy();

    // Hand the keyboard to the other pane, so activating the frame's pane is
    // a change and not the state it was already in.
    const otherPaneId = await ctx.page.evaluate((frameId) => {
      const { panes, activeWindowId } = window.app.getSnapshot().context;
      return panes.find((p) => p.windowId === activeWindowId && p.tmuxId !== frameId)?.tmuxId;
    }, framePaneId);
    await ctx.page.click(`[data-pane-id="${otherPaneId}"] [role="log"]`);
    await waitForCondition(
      ctx.page,
      async () => (await paneState(ctx.page)).activePaneId === otherPaneId,
      10000,
      'the keyboard to move to the other pane',
    );

    // 1. A click on the PAGE activates the pane it is in. The click still
    //    reaches the page — one gesture, as on a terminal pane.
    await ctx.page.mouse.move(centre.x, centre.y);
    await ctx.page.mouse.down();
    await delay(DELAYS.MEDIUM);
    await ctx.page.mouse.up();
    await waitForCondition(
      ctx.page,
      async () => (await paneState(ctx.page)).activePaneId === framePaneId,
      10000,
      // Focus is the only signal that crosses a frame boundary
      // (`useFramedPaneFocus`): a click inside blurs the parent window and
      // makes the `<iframe>` the parent document's activeElement. Every part
      // of that can be missing in a headless browser, and "the pane did not
      // activate" alone cannot say which.
      async () => {
        const seen = await ctx.page.evaluate(() => {
          const el = document.activeElement;
          return {
            activeTag: el?.tagName ?? null,
            activeClass: typeof el?.className === 'string' ? el.className : null,
            documentHasFocus: document.hasFocus(),
            insideWidgetPane: !!el?.closest?.('[role=group][aria-label^="Widget pane"]'),
          };
        });
        const state = await paneState(ctx.page);
        return `clicking the embedded page to activate its pane (wanted ${framePaneId}, active ${state.activePaneId}; ${JSON.stringify(seen)})`;
      },
    );

    // 2. A divider dragged ACROSS the page keeps resizing. The frame used to
    //    swallow every move once the cursor crossed into it, so the divider
    //    stopped following and the `mouseup` never arrived either — leaving
    //    the app stuck in a resize until some later click landed elsewhere.
    const divider = await ctx.page.evaluate(() => {
      const el = document.querySelector('.resize-divider');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    expect(divider).not.toBeNull();

    const before = await paneState(ctx.page);
    await ctx.page.mouse.move(divider.x, divider.y);
    await ctx.page.mouse.down();
    // Walk the cursor well inside the frame, a step at a time.
    for (const x of [divider.x + 40, divider.x + 120, centre.x]) {
      await ctx.page.mouse.move(x, divider.y);
      await delay(DELAYS.SHORT);
    }
    const midDrag = await paneState(ctx.page);
    await ctx.page.mouse.up();

    expect(midDrag.widths[otherPaneId]).toBeGreaterThan(before.widths[otherPaneId]);
    expect(midDrag.widths[framePaneId]).toBeLessThan(before.widths[framePaneId]);

    // The gesture ends with the pointer release, wherever the pointer was.
    await waitForCondition(
      ctx.page,
      async () => !(await paneState(ctx.page)).resizing,
      10000,
      'the resize to end when the button came up over the page',
    );
  }, 120000);
});
