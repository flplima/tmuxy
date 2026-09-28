/**
 * Read-only E2E Tests
 *
 * A `--read-only` server beside the suite's own: one page writes through the
 * normal server, the other watches the same session through the read-only one.
 */

const path = require('path');
const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  navigateToSession,
  waitForCondition,
  DELAYS,
} = require('./helpers');
const { READ_ONLY_URL, startReadOnlyServer } = require('./helpers/read-only-server');
const { getCopyModeState } = require('./helpers/copy-mode');

const TMUXY_CLI = path.resolve(__dirname, '..', 'bin/tmuxy-cli');

/**
 * What a page actually shows: the text and box of every terminal that is
 * painted inside the pane area, plus that area's own box. A terminal that is
 * in the DOM but belongs to a hidden tab has no box here.
 */
function visibleTerminals() {
  const area = document.querySelector('.pane-container').getBoundingClientRect();
  const terminals = [];
  for (const el of document.querySelectorAll('[data-pane-id] [role="log"]')) {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
    if (el.closest('.pane-window-hidden')) continue;
    terminals.push({
      paneId: el.closest('[data-pane-id]').getAttribute('data-pane-id'),
      text: el.textContent || '',
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
    });
  }
  return {
    area: { left: area.left, top: area.top, right: area.right, bottom: area.bottom },
    terminals,
  };
}

const shows = async (page, token) =>
  (await page.evaluate(visibleTerminals)).terminals.some((t) => t.text.includes(token));

/** The tab the strip marks selected, by its position in the strip. */
const selectedTab = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.tab-name')].findIndex(
      (tab) => tab.getAttribute('aria-selected') === 'true',
    ),
  );

const gridSize = (page) =>
  page.evaluate(() => {
    const c = window.app.getSnapshot().context;
    return `${c.totalWidth}x${c.totalHeight}`;
  });

describe('Scenario 30: Read-only viewer', () => {
  const ctx = createTestContext();
  let stopReadOnlyServer = () => {};

  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    stopReadOnlyServer();
    stopReadOnlyServer = () => {};
    await ctx.afterEach();
  }, ctx.hookTimeout);

  /**
   * The viewer's server, pinned to this test's session.
   *
   * It is started here rather than in a hook because a read-only server is
   * pinned to ONE session and the session is named per test — and because
   * starting a second server on the socket while the writer's session is still
   * being brought up disturbs it.
   */
  async function viewerServer() {
    stopReadOnlyServer = await startReadOnlyServer(ctx.session.name);
  }

  test('viewer follows output → keeps its own tab → cannot type, resize or change anything', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const writer = ctx.page;
    const stamp = Date.now();
    const FIRST = `FIRST_${stamp}`;
    const SECOND = `SECOND_${stamp}`;
    const LATER = `LATER_${stamp}`;
    const REFUSED = `REFUSED_${stamp}`;

    // The writer: a marker on tab 1, then a second tab with its own marker.
    await typeInTerminal(writer, `echo ${FIRST}`);
    await pressEnter(writer);
    await waitForCondition(writer, () => shows(writer, FIRST), 10000, 'first marker on writer');
    await writer.click('.tab-add');
    await waitForCondition(writer, async () => (await selectedTab(writer)) === 1, 10000, 'tab 2');
    await focusPage(writer);
    await typeInTerminal(writer, `echo ${SECOND}`);
    await pressEnter(writer);
    await waitForCondition(writer, () => shows(writer, SECOND), 10000, 'second marker on writer');
    const writerGrid = await gridSize(writer);

    // The viewer: a much smaller window on the read-only server.
    await viewerServer();
    const viewer = await ctx.browser.newPage();
    await viewer.setViewportSize({ width: 640, height: 420 });
    await navigateToSession(viewer, ctx.session.name, READ_ONLY_URL);
    await viewer.bringToFront();
    await waitForCondition(viewer, () => shows(viewer, SECOND), 15000, 'viewer sees tab 2');
    expect(await viewer.locator('.read-only-badge').isVisible()).toBe(true);
    for (const control of [
      '.tab-add',
      '.pane-header-close',
      '.pane-header-menu',
      '.resize-divider',
      '.sidebar-toggle-left',
      '.sidebar-toggle-right',
    ]) {
      expect(await viewer.locator(control).count()).toBe(0);
    }

    // Its small window resized nothing, and the whole grid is drawn inside it.
    await delay(DELAYS.SYNC);
    expect(await gridSize(viewer)).toBe(writerGrid);
    expect(await gridSize(writer)).toBe(writerGrid);
    const fitted = await viewer.evaluate(visibleTerminals);
    expect(fitted.terminals.length).toBeGreaterThan(0);
    for (const { box } of fitted.terminals) {
      expect(box.left).toBeGreaterThanOrEqual(fitted.area.left);
      expect(box.top).toBeGreaterThanOrEqual(fitted.area.top);
      expect(box.right).toBeLessThanOrEqual(fitted.area.right + 1);
      expect(box.bottom).toBeLessThanOrEqual(fitted.area.bottom + 1);
    }

    // The viewer goes to tab 1. Only the viewer does.
    await viewer.locator('.tab-name').first().click();
    await waitForCondition(viewer, () => shows(viewer, FIRST), 10000, 'viewer on tab 1');
    expect(await shows(viewer, SECOND)).toBe(false);
    expect(await selectedTab(viewer)).toBe(0);
    await writer.bringToFront();
    expect(await selectedTab(writer)).toBe(1);
    expect(await shows(writer, SECOND)).toBe(true);

    // The writer carries on in tab 2; the viewer stays where it chose to be.
    await focusPage(writer);
    await typeInTerminal(writer, `echo ${LATER}`);
    await pressEnter(writer);
    await waitForCondition(writer, () => shows(writer, LATER), 10000, 'later marker on writer');
    await viewer.bringToFront();
    await delay(DELAYS.SYNC);
    expect(await selectedTab(viewer)).toBe(0);
    expect(await shows(viewer, FIRST)).toBe(true);
    expect(await shows(viewer, LATER)).toBe(false);

    // Back on tab 2 the viewer sees what was written meanwhile — and what it
    // types itself goes nowhere.
    await viewer.locator('.tab-name').nth(1).click();
    await waitForCondition(viewer, () => shows(viewer, LATER), 10000, 'viewer back on tab 2');
    await typeInTerminal(viewer, `echo ${REFUSED}`);
    await pressEnter(viewer);
    await delay(DELAYS.SYNC);
    expect(await shows(viewer, REFUSED)).toBe(false);
    await writer.bringToFront();
    expect(await shows(writer, REFUSED)).toBe(false);

    // The "all tabs" view offers a viewer the tabs and nothing else: no close
    // buttons, no "+" card. Picking a card still moves only the viewer.
    await viewer.bringToFront();
    await viewer.locator('[data-testid="tab-overview-toggle"]').click();
    await viewer.locator('[data-testid="tab-overview"]').waitFor({ state: 'visible' });
    expect(await viewer.locator('.tab-overview-slot').count()).toBe(2);
    expect(await viewer.locator('.tab-overview-slot-close').count()).toBe(0);
    expect(await viewer.locator('[data-testid="tab-overview-new"]').count()).toBe(0);
    await viewer.locator('.tab-overview-slot').first().click();
    await waitForCondition(viewer, () => shows(viewer, FIRST), 10000, 'viewer picked tab 1');
    expect(await selectedTab(viewer)).toBe(0);
    await writer.bringToFront();
    expect(await selectedTab(writer)).toBe(1);

    // And the server refuses a write even from a client that tries.
    const status = await viewer.evaluate(async (session) => {
      const response = await fetch(`/commands?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'run_tmux_command', args: { command: 'kill-server' } }),
      });
      return response.status;
    }, ctx.session.name);
    expect(status).toBe(403);

    await viewer.close();
  }, 120000);

  /**
   * SEC-11/SEC-12. The recommended setup puts the viewer on the SAME tmux
   * socket as the writer, so every other session of yours is one `?session=`
   * away. A viewer used to be handed any of them — and handed a brand new one,
   * shell and all, for any name that did not exist yet.
   */
  test('a viewer cannot reach a session beside the one it was given, or bring one into being', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // A second session on the same socket, the way a writer's other work sits
    // beside the shared one. It is made the way a user makes one — by opening
    // it on the WRITABLE server — because an external `tmux new-session`
    // crashes tmux 3.5a while control mode is attached (docs/TMUX.md).
    const neighbour = `${ctx.session.name}-neighbour`;
    const other = await ctx.browser.newPage();
    await navigateToSession(other, neighbour);
    const invented = `${ctx.session.name}-invented`;

    await viewerServer();
    const viewer = await ctx.browser.newPage();
    await navigateToSession(viewer, ctx.session.name, READ_ONLY_URL);

    const statusOf = (session) =>
      viewer.evaluate(async (name) => {
        const response = await fetch(`/events?session=${encodeURIComponent(name)}`);
        // Read nothing: a 200 would be an open stream, and the status is the answer.
        return response.status;
      }, session);

    expect(await statusOf(neighbour)).toBe(404);
    expect(await statusOf(invented)).toBe(404);

    // Nor is a viewer told about the host beyond the screen it watches: the
    // trace settings name a file under the server's home, and the repository
    // list is the cwd of every pane on the socket — refused and empty.
    const command = (cmd) =>
      viewer.evaluate(
        async ({ body, session }) => {
          const response = await fetch(`/commands?session=${encodeURIComponent(session)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const text = await response.text();
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { text };
          }
          return { status: response.status, body: parsed };
        },
        { body: cmd, session: ctx.session.name },
      );
    expect((await command({ cmd: 'get_trace_settings', args: {} })).status).toBe(403);
    const worktrees = await command({ cmd: 'list_git_worktrees', args: {} });
    expect(worktrees.status).toBe(200);
    expect(worktrees.body.result).toEqual([]);

    // ...and asking for it did not create it.
    const sessions = await other.evaluate(async (name) => {
      const response = await fetch(`/commands?session=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'query_tmux',
          args: { command: "list-sessions -F '#{session_name}'" },
        }),
      });
      return (await response.json()).result;
    }, neighbour);
    expect(sessions).toContain(neighbour);
    expect(sessions).not.toContain(invented);

    await viewer.close();
    await other.close();
  }, 120000);

  /**
   * SEC-11. The viewer's server has one monitor, started with the server and
   * kept for its life: it waits for a session that is not there yet, attaches
   * when it appears, answers "nothing to show" while it is gone, and attaches
   * again when it is re-made — and none of that is a viewer's doing.
   */
  test('the viewer server waits for its session, survives it being killed, and picks it up again', async () => {
    if (ctx.skipIfNotReady()) return;
    // The viewer's server first, pinned to a session nobody has made.
    await viewerServer();
    const viewer = await ctx.browser.newPage();
    await viewer.goto(READ_ONLY_URL);
    const streamStatus = () =>
      viewer.evaluate(async (name) => {
        const response = await fetch(`/events?session=${encodeURIComponent(name)}`);
        return response.status;
      }, ctx.session.name);
    expect(await streamStatus()).toBe(404);

    // The writer brings the session into being; the viewer's server notices
    // on its own and attaches. The wait is for that attach, however long the
    // runner takes to get there.
    await ctx.setupPage();
    const writer = ctx.page;
    await waitForCondition(
      viewer,
      async () => (await streamStatus()) === 200,
      20000,
      'the viewer server to attach',
    );
    const FIRST = `FIRST_${Date.now()}`;
    await typeInTerminal(writer, `echo ${FIRST}`);
    await pressEnter(writer);
    await navigateToSession(viewer, ctx.session.name, READ_ONLY_URL);
    await waitForCondition(
      viewer,
      () => shows(viewer, FIRST),
      15000,
      'the viewer to see the session',
    );

    // A viewer's scrollback is served on the session's own control-mode
    // connection, checked against its own pane list there: rows that scrolled
    // off the writer's screen come back into the viewer's scroll view.
    await typeInTerminal(writer, 'for i in $(seq 0 79); do echo "line-$i"; done');
    await pressEnter(writer);
    await waitForCondition(
      viewer,
      () => shows(viewer, 'line-79'),
      15000,
      'the viewer to see the last line',
    );
    const lowestLine = (rows) => {
      const numbers = rows.flatMap((t) => [...t.matchAll(/line-(\d+)/g)].map((m) => Number(m[1])));
      return numbers.length > 0 ? Math.min(...numbers) : null;
    };
    // The screen cannot hold 80 lines, so the early ones have scrolled off —
    // they are what the scroll view has to bring back.
    const liveLowest = lowestLine(
      (await viewer.evaluate(visibleTerminals)).terminals.map((t) => t.text),
    );
    expect(liveLowest).toBeGreaterThan(0);
    const pane = await viewer.evaluate(() => {
      const r = document.querySelector('[data-pane-id] [role="log"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await viewer.mouse.move(pane.x, pane.y);
    await waitForCondition(
      viewer,
      async () => {
        await viewer.mouse.wheel(0, -120);
        await delay(100);
        return (await getCopyModeState(viewer))?.mode === 'scroll';
      },
      15000,
      "the viewer's scroll view to open",
    );
    // Rows drawn in the view with a real box, and among them one from above
    // the live screen: history the viewer's server fetched on the session's
    // own connection.
    let drawnLowest = null;
    await waitForCondition(
      viewer,
      async () => {
        const drawn = await viewer.evaluate(() => {
          const el = document.querySelector('[data-testid="scrollback-terminal"]');
          if (!el) return [];
          return [...el.querySelectorAll('.terminal-line')]
            .filter((l) => {
              const b = l.getBoundingClientRect();
              return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight;
            })
            .map((l) => l.textContent || '');
        });
        drawnLowest = lowestLine(drawn);
        return drawnLowest !== null && drawnLowest < liveLowest;
      },
      15000,
      async () =>
        `a row from above the live screen to be drawn in the scroll view (live lowest line-${liveLowest}, drawn lowest ${drawnLowest}, state ${JSON.stringify(await getCopyModeState(viewer))})`,
    );

    // The session goes away under it. The writer's page is closed first so
    // the writable server does not recreate the session on its behalf.
    await writer.close();
    await ctx.session.destroy();
    await waitForCondition(
      viewer,
      async () => (await streamStatus()) === 404,
      20000,
      'the viewer server to notice the session is gone',
    );

    // ...and comes back, by the writer's hand, not the viewer's.
    ctx.page = await ctx.browser.newPage();
    await navigateToSession(ctx.page, ctx.session.name);
    ctx.session.created = true;
    await waitForCondition(
      viewer,
      async () => (await streamStatus()) === 200,
      20000,
      'the viewer server to attach again',
    );
    const SECOND = `SECOND_${Date.now()}`;
    await typeInTerminal(ctx.page, `echo ${SECOND}`);
    await pressEnter(ctx.page);
    await navigateToSession(viewer, ctx.session.name, READ_ONLY_URL);
    await waitForCondition(
      viewer,
      () => shows(viewer, SECOND),
      15000,
      'the viewer to see the re-made session',
    );

    await viewer.close();
  }, 180000);

  /**
   * SEC-18. Whoever ran `tmuxy widget browser` in the session chose its page;
   * a viewer watching that session did not, and their browser must not fetch
   * it — a remote site would learn who is watching, and a local file the
   * read-only server refuses anyway. The viewer sees the address, not the page.
   */
  test('a viewer sees which page a widget pane shows, and does not load it', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const writer = ctx.page;
    const file = `/tmp/tmuxy-widget-viewer-${Date.now()}.html`;
    await typeInTerminal(
      writer,
      `printf '<h1>PAGE</h1>' > ${file}; ${TMUXY_CLI} widget browser ${file}`,
    );
    await pressEnter(writer);
    const frameBox = (page) =>
      page.evaluate(() => {
        const el = document.querySelector('.widget-browser-frame');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 20;
      });
    await waitForCondition(
      writer,
      async () => (await frameBox(writer)) === true,
      30000,
      'the writer to draw the frame',
    );

    await viewerServer();
    const viewer = await ctx.browser.newPage();
    await navigateToSession(viewer, ctx.session.name, READ_ONLY_URL);
    const notice = viewer.locator('[data-testid="browser-read-only"]');
    await notice.waitFor({ state: 'visible', timeout: 15000 });
    expect(await notice.textContent()).toContain(file);
    expect(await viewer.locator('iframe').count()).toBe(0);

    await viewer.close();
  }, 120000);
});
