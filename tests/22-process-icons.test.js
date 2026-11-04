/**
 * Process icons as the user sees them: a pane's header wears its process's
 * icon, an SVG drawn as its shape in the colour of the text beside it
 * (components/PaneIcon.tsx). The pixels are read off a screenshot
 * (helpers/process-icon.js), so what is checked is what is on screen.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTestContext,
  navigateToSession,
  waitForCondition,
  splitPaneKeyboard,
  waitForPaneCount,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
} = require('./helpers');
const {
  CONFIG_URL,
  CONFIG_DIR,
  startConfigServer,
  reloadConfig,
  unsetConfigVariable,
  iconSetFor,
} = require('./helpers/config-server');
const { iconPixels } = require('./helpers/process-icon');

describe('Scenario: a pane header wears its process icon, an SVG in the text colour', () => {
  const ctx = createTestContext();
  let stopServer = () => {};

  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    stopServer();
    stopServer = () => {};
    unsetConfigVariable();
    await ctx.afterEach();
  }, ctx.hookTimeout);

  // An SVG icon is drawn as the user sees it, so its pixels are read off a
  // screenshot: whatever colours the file has, what it covers is the text's
  // colour and what it leaves transparent is the header behind it.
  test('an SVG in icons/ named by @tmuxy-icon-<process> is the pane icon, its shape in the text colour', async () => {
    if (ctx.skipIfNotReady()) return;
    unsetConfigVariable();
    stopServer = await startConfigServer();
    const page = ctx.page;
    await navigateToSession(page, ctx.session.name, CONFIG_URL);
    await page.waitForSelector('.pane-layout-item.pane-active', { timeout: 15000 });
    // Two panes, so each wears its icon in a header.
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    const { paneId, command } = await page.evaluate(() => {
      const { panes, activePaneId } = window.app.getSnapshot().context;
      return {
        paneId: activePaneId,
        command: panes.find((p) => p.tmuxId === activePaneId).command,
      };
    });

    // A square ring, orange on the left and blue on the right, with a
    // transparent hole: the hole must show the header, the ring the text colour.
    fs.mkdirSync(path.join(CONFIG_DIR, 'icons'), { recursive: true });
    fs.writeFileSync(
      path.join(CONFIG_DIR, 'icons', 'ring.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
        '<path fill="#ff8800" fill-rule="evenodd" d="M0 0h8v16H0zM5 5h3v6H5z"/>' +
        '<path fill="#2040ff" fill-rule="evenodd" d="M8 0h8v16H8zM8 5h3v6H8z"/></svg>',
    );
    iconSetFor(command);
    fs.appendFileSync(
      path.join(CONFIG_DIR, 'tmuxy.conf'),
      `\nset -g @tmuxy-icon-${command} ring.svg\n`,
    );
    reloadConfig();

    let seen = null;
    await waitForCondition(
      page,
      async () => {
        seen = await iconPixels(page, paneId);
        return !!seen;
      },
      15000,
      () => 'the SVG icon in the pane header',
    );
    const { at, text, background, opacity, inTab, width, height, scale } = seen;
    expect(inTab).toBe(true);
    // The icon sits on the header, so with its opacity the text colour is
    // seen mixed into the header's background.
    const expected = text.map((c, k) => Math.round(c * opacity + background[k] * (1 - opacity)));
    const near = (a, b) => a.every((c, k) => Math.abs(c - b[k]) <= 4);
    const kind = (x, y) => {
      const c = at(x, y);
      if (near(c, expected)) return 'text';
      return near(c, background) ? 'background' : `other ${c}`;
    };
    // Orange and blue alike are the text colour, the hole is the header.
    expect({
      orange: kind(2.5 / 16, 0.5),
      blue: kind(13.5 / 16, 0.5),
      hole: kind(0.5, 0.5),
    }).toEqual({ orange: 'text', blue: 'text', hole: 'background' });
    // The ring is drawn out to every edge of its box, give or take the pixel
    // the box's edge straddles: nothing of the shape is cut.
    const span = (points) => {
      // Anything but the header counts: an edge pixel half covered is a blend.
      const drawn = points.map(([x, y]) => kind(x, y) !== 'background');
      const inset = (i) => (i < 0 ? points.length : Math.max(0, i - 1));
      return [inset(drawn.indexOf(true)), inset(points.length - 1 - drawn.lastIndexOf(true))];
    };
    const steps = (n) => [...Array(n).keys()].map((i) => (i + 0.5) / n);
    expect({
      across: span(steps(width).map((x) => [x, 0.25])),
      down: span(steps(height).map((y) => [0.5, y])),
    }).toEqual({ across: [0, 0], down: [0, 0] });
    // At the size of the text beside it.
    expect(width).toBeGreaterThanOrEqual(8 * scale);
    expect(Math.abs(width - height)).toBeLessThanOrEqual(1);
  }, 90000);

  // The built-in agent marks are whole in their box: a pane running `agy`
  // (a shell under that name, which is all the client goes by) wears the
  // Antigravity arch with its feet, not cut at the box's edge.
  test('an agent pane wears its own mark, whole and in the text colour', async () => {
    if (ctx.skipIfNotReady()) return;
    unsetConfigVariable();
    const page = ctx.page;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    await waitForShellPrompt(page);
    const paneId = await page.evaluate(() => window.app.getSnapshot().context.activePaneId);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-agy-'));
    const agy = path.join(dir, 'agy');
    fs.copyFileSync('/bin/bash', agy);
    fs.chmodSync(agy, 0o755);
    try {
      await typeInTerminal(page, `${agy} -c 'read -t 60'`, {
        target: `[data-pane-id="${paneId}"] [role="log"]`,
      });
      await pressEnter(page);
      let seen = null;
      await waitForCondition(
        page,
        async () => {
          seen = await iconPixels(page, paneId);
          return !!seen;
        },
        15000,
        () => 'the Antigravity mark in the pane header',
      );
      expect(seen.inTab).toBe(true);
      // The shape lies inside the box the SVG gives it, so the box holds it all.
      expect(seen.shapeInViewBox).toBe(true);
      // Its feet: the two bottom corners are drawn, the middle between them is not.
      const drawn = (x, y) => seen.at(x, y).some((c, k) => Math.abs(c - seen.background[k]) > 24);
      expect([drawn(0.08, 0.92), drawn(0.92, 0.92), drawn(0.5, 0.92)]).toEqual([true, true, false]);
    } finally {
      await page.keyboard.press('Control+c');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
