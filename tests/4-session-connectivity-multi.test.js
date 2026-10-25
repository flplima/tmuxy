/**
 * Session & Connectivity E2E Tests (Origin, Reverse Proxy & Session Switcher)
 *
 * Cross-origin refusal, reverse-proxy allowed-host, and web session switcher scenarios.
 */

const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  navigateToSession,
  waitForCondition,
  waitForPaneCount,
  splitPaneKeyboard,
  clickMenuItem,
  DELAYS,
  TMUXY_URL,
  TMUXY_PORT,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');
const { waitForMonitorGone } = require('./helpers/monitor');
const { startExtraServer } = require('./helpers/extra-server');
const { startPublicNameProxy } = require('./helpers/public-name-proxy');

// ==================== Scenario 22b: Other Origins Cannot Drive tmux ====================

describe('Scenario 22b: Other origins cannot drive tmux', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a page on another origin posts a command → tmux never runs it → the app itself still can [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const session = ctx.session.name;
    const commandsUrl = `${TMUXY_URL}/commands?session=${encodeURIComponent(session)}`;
    // Each request writes an option of its own, so the forged one can be
    // judged after the allowed one lands: both reach tmux over the one
    // control connection, in the order the server took them, so a forged
    // write the server let through would be in place before the allowed one.
    const readOption = (option) => tmuxExec(`show-options -t ${session} -qv ${option}`);
    const commandBody = (option, value) =>
      JSON.stringify({
        cmd: 'run_tmux_command',
        args: { command: `set-option -t ${session} ${option} ${value}` },
      });

    // A site the user happens to have open in the same browser: another
    // origin, posting the command the way any page can without a CORS
    // preflight — text/plain, no-cors.
    const http = require('http');
    const site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>elsewhere</title>');
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    const elsewhere = await ctx.browser.newPage();
    try {
      await elsewhere.goto(`http://127.0.0.1:${site.address().port}/`);
      await elsewhere.evaluate(
        async ({ url, body }) => {
          await fetch(url, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body,
          }).catch(() => {});
        },
        { url: commandsUrl, body: commandBody('@tmuxy-e2e-forged', 'forged') },
      );
    } finally {
      await elsewhere.close();
      site.close();
    }

    // The same command from the app's own page goes through: what was refused
    // above was where the command came from, not the command.
    await ctx.page.bringToFront();
    await ctx.page.evaluate(
      async ({ url, body }) => {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      },
      { url: commandsUrl, body: commandBody('@tmuxy-e2e-origin', 'allowed') },
    );
    await waitForCondition(
      ctx.page,
      async () => readOption('@tmuxy-e2e-origin') === 'allowed',
      10000,
      "the app's own command to set the option",
    );
    expect(readOption('@tmuxy-e2e-forged')).toBe('');
  }, 180000);
});

// ==================== Scenario 22c: Behind a Reverse Proxy ====================

describe('Scenario 22c: Published under another name by a reverse proxy', () => {
  const ctx = createTestContext();
  const PUBLIC_NAME = 'tmuxy.proxy.test';
  const ALLOWED_PORT = TMUXY_PORT + 110;
  let refused;
  let allowed;
  let stopAllowedServer = () => {};

  beforeAll(async () => {
    await ctx.beforeAll();
    // The suite's own server was started without --allowed-host; a second one
    // is told the public name. Each sits behind a proxy forwarding that name.
    stopAllowedServer = await startExtraServer(ALLOWED_PORT, ['--allowed-host', PUBLIC_NAME]);
    refused = await startPublicNameProxy({
      listenPort: TMUXY_PORT + 111,
      targetPort: TMUXY_PORT,
      publicName: PUBLIC_NAME,
    });
    allowed = await startPublicNameProxy({
      listenPort: TMUXY_PORT + 112,
      targetPort: ALLOWED_PORT,
      publicName: PUBLIC_NAME,
    });
  }, ctx.hookTimeout);
  afterAll(async () => {
    refused?.stop();
    allowed?.stop();
    stopAllowedServer();
    await ctx.afterAll();
  });
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a name the server was not told about → the page says why instead of "Connecting…" forever → with --allowed-host the same name works [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const session = encodeURIComponent(ctx.session.name);

    // Refused: the app loads (static files are not guarded) but every API route
    // is a 403. The user has to be shown that, with the server's own reason —
    // it used to sit on the spinner for good, retrying what could never work.
    const page = await ctx.browser.newPage();
    await page.goto(`${refused.url}?session=${session}`, { waitUntil: 'domcontentloaded' });
    const verdict = page.locator('[data-testid="fatal-display"]');
    await verdict.waitFor({ state: 'visible', timeout: 20000 });
    const text = await verdict.innerText();
    expect(text).toContain('The server refused this page');
    expect(text).toContain('--allowed-host');
    // Visibly so: on screen with a real box, not merely present in the DOM.
    const box = await verdict.locator('.connection-overlay-text').boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(await page.locator('[data-testid="loading-display"]').count()).toBe(0);
    expect(await page.getByRole('button', { name: /retry/i }).isVisible()).toBe(true);
    // It stays refused rather than flapping back to the spinner.
    await delay(DELAYS.SYNC * 2);
    expect(await verdict.isVisible()).toBe(true);

    // Allowed: the same public name, a server that was told about it.
    await navigateToSession(page, ctx.session.name, allowed.url);
    await page.bringToFront();
    expect(await page.locator('[data-testid="fatal-display"]').count()).toBe(0);
    const token = `PROXIED_${Date.now()}`;
    await focusPage(page);
    await typeInTerminal(page, `echo ${token}`);
    await pressEnter(page);
    await waitForTerminalText(page, token);

    await page.close();
  }, 120000);
});

// ==================== Scenario 24: Session Switcher (web) ====================

describe('Scenario 24: Session Switcher (web)', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The web build enumerates every session on its tmux socket (not just the
  // attached one) via the `serversActor` poll and offers them in the status
  // line's switcher dropdown; the tree stays the current session's own tabs
  // and panes. This exercises that full chain on the real HTTP/SSE transport,
  // which the unit + storybook tests can't (they mock the poll and never
  // reconnect the stream).
  test('a sibling session is offered in the switcher, not the tree, and picking it switches the web client [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;

    // Bounding-rect probe: a row or menu item must be visually present, not
    // just in the DOM (per docs/TESTS.md — an element clipped to 0px is not
    // "shown").
    const rect = (selector) =>
      ctx.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top };
      }, selector);

    // Setup (NOT the feature under test): a second, vanilla tmux session on the
    // same socket. Created via external `new-session` BEFORE navigating — no
    // control-mode client is attached yet, so this is safe on tmux 3.5a (the
    // same reason the beforeEach warmup uses a raw new-session). It stands in
    // for "another session someone started on this server outside tmuxy".
    const siblingName = `tmuxy_sibling_${Date.now()}`;
    tmuxExec(`new-session -d -s ${siblingName} -x 200 -y 50 -n foreignwin`);
    const siblingWinId = tmuxExec(`list-windows -t ${siblingName} -F '#{window_id}'`);
    expect(siblingWinId).toMatch(/^@\d+$/);

    try {
      // Connect the web client to the primary session (the server creates it via
      // `tmux -CC new-session`). The socket now hosts two sessions.
      await ctx.setupPage();
      const primaryName = ctx.session.name;

      // Open the sidebar the way a user does — the header toggle button
      // (dispatches the same TOGGLE_LEFT_SIDEBAR as `prefix t`).
      await ctx.page.click('button[aria-label="Toggle tree sidebar"]');
      await ctx.page.waitForSelector('.sidebar-column-left', { timeout: 20000 });

      // The tree is THIS session's: its active window's tab is drawn...
      const primaryWinId = await ctx.page.evaluate(
        () => window.app?.getSnapshot()?.context?.activeWindowId,
      );
      await waitForCondition(
        ctx.page,
        async () => {
          const row = await rect(`[data-testid="tree-tab-${primaryWinId}"]`);
          return !!row && row.h > 0;
        },
        20000,
        "this session's own tab to appear in the tree",
      );
      // ...and the sibling's window is nowhere in it, nor is any session header.
      expect(await rect(`[data-testid="tree-tab-${siblingWinId}"]`)).toBeNull();
      expect(await ctx.page.locator('[data-testid^="tree-session-"]').count()).toBe(0);

      // Where the other sessions live now: the switcher hanging off the status
      // line's session name. The poll (~1.5s) is what fills it, so wait for the
      // sibling's item rather than assuming the first open holds it.
      const siblingItem = `[data-session-name="${siblingName}"]`;
      await waitForCondition(
        ctx.page,
        async () => {
          if ((await ctx.page.locator(siblingItem).count()) === 0) {
            await ctx.page.click('.statusline-session');
            await delay(DELAYS.SYNC);
            return false;
          }
          const item = await rect(siblingItem);
          return !!item && item.h > 0 && item.w > 20;
        },
        20000,
        'the sibling session to be offered in the switcher',
      );

      // The attached session is marked as the one we are on.
      const current = await ctx.page.getAttribute(
        `[data-session-name="${primaryName}"]`,
        'data-current',
      );
      expect(current).not.toBeNull();

      // Picking the sibling is the real user path for switching. On web this
      // reconnects the SSE stream to that session.
      await ctx.page.click(siblingItem);
      await waitForCondition(
        ctx.page,
        async () =>
          ctx.page.evaluate(
            (name) => window.app?.getSnapshot()?.context?.sessionName === name,
            siblingName,
          ),
        15000,
        'web client to switch to the sibling session',
      );

      // The switch is real end-to-end: URL reflects it and the terminal for the
      // new session renders with a visible area (not a blank/disconnected view).
      const urlSession = await ctx.page.evaluate(() =>
        new URL(window.location.href).searchParams.get('session'),
      );
      expect(urlSession).toBe(siblingName);
      await ctx.page.waitForSelector('[role="log"]', { timeout: 15000 });
      const termRect = await rect('[role="log"]');
      expect(termRect).not.toBeNull();
      expect(termRect.w).toBeGreaterThan(50);
      expect(termRect.h).toBeGreaterThan(50);
    } finally {
      // Kill the sibling session (kill-session is safe to run externally per
      // docs/TMUX.md, even with control mode attached). The primary session is
      // cleaned up by afterEach.
      try {
        tmuxExec(`kill-session -t ${siblingName}`);
      } catch {
        // Already gone — fine.
      }
      await waitForMonitorGone(siblingName);
    }
  }, 180000);

  // A dozen and more sessions — the setup of the user who asked for a
  // switcher (issue #60). The list ran off the screen at about twelve.
  test('twenty sessions: the switcher stays on screen and scrolls, typing filters it, Enter switches', async () => {
    if (ctx.skipIfNotReady()) return;

    // Setup, as above: vanilla sessions created before the page attaches.
    const stamp = Date.now();
    const target = `tmuxy_pick_${stamp}`;
    const others = Array.from({ length: 19 }, (_, i) => `tmuxy_many_${stamp}_${i}`);
    for (const name of [...others, target]) tmuxExec(`new-session -d -s ${name} -x 200 -y 50`);

    const geometry = () =>
      ctx.page.evaluate((name) => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
        };
        const list = document.querySelector('[data-testid="session-switcher"] [role="listbox"]');
        const rows = [
          ...document.querySelectorAll('[data-testid="session-switcher"] [data-session-name]'),
        ];
        const listBottom = list?.getBoundingClientRect().bottom ?? 0;
        return {
          viewport: { w: window.innerWidth, h: window.innerHeight },
          switcher: box(document.querySelector('[data-testid="session-switcher"]')),
          list: box(list),
          scrollable: list ? list.scrollHeight > list.clientHeight : false,
          rows: rows.length,
          belowList: rows.filter((row) => row.getBoundingClientRect().top >= listBottom - 1).length,
          target: box(document.querySelector(`[data-session-name="${name}"]`)),
          filter: document.activeElement?.getAttribute('aria-label') ?? null,
        };
      }, target);

    try {
      await ctx.setupPage();
      const total = others.length + 2; // and the session the page attached to

      // Open it from the status line; the poll fills it, so reopen until it
      // lists every session.
      await waitForCondition(
        ctx.page,
        async () => {
          const g = await geometry();
          if (g.rows >= total) return true;
          if (!g.switcher) await ctx.page.click('.statusline-session');
          return false;
        },
        20000,
        async () => `every session in the switcher\n${JSON.stringify(await geometry())}`,
      );

      // On screen, whole, with the list scrolling inside it: the last
      // sessions are below the list's edge, not below the window's.
      let g = await geometry();
      expect(g.switcher.top).toBeGreaterThanOrEqual(0);
      expect(g.switcher.bottom).toBeLessThanOrEqual(g.viewport.h);
      expect(g.switcher.right).toBeLessThanOrEqual(g.viewport.w);
      expect(g.scrollable).toBe(true);
      expect(g.belowList).toBeGreaterThan(0);

      // The keyboard is in the filter box: typing narrows the list to the one
      // session, now in view. This run's own stamp, not just "pick": a
      // session left on the socket by an earlier run would match that too.
      expect(g.filter).toBe('Filter sessions');
      await ctx.page.keyboard.type(`PICK_${stamp}`);
      await waitForCondition(
        ctx.page,
        async () => (await geometry()).rows === 1,
        10000,
        async () => `the filter to leave one session\n${JSON.stringify(await geometry())}`,
      );
      g = await geometry();
      expect(g.target.h).toBeGreaterThan(8);
      expect(g.target.top).toBeGreaterThanOrEqual(g.list.top);
      expect(g.target.bottom).toBeLessThanOrEqual(g.list.bottom + 1);

      // Enter picks it, and the client switches.
      await ctx.page.keyboard.press('Enter');
      await waitForCondition(
        ctx.page,
        async () =>
          ctx.page.evaluate(
            (name) => window.app?.getSnapshot()?.context?.sessionName === name,
            target,
          ),
        15000,
        'web client to switch to the filtered session',
      );
      expect(await ctx.page.locator('[data-testid="session-switcher"]').count()).toBe(0);
    } finally {
      for (const name of [...others, target]) {
        try {
          tmuxExec(`kill-session -t ${name}`);
        } catch {
          // Already gone — fine.
        }
      }
    }
  }, 180000);

  test("the app menu's New Session creates a session and moves the page to it; the first comes back with its panes [nightly]", async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const primaryName = ctx.session.name;
    // Two panes, so the session the switch comes back to is recognisably this one.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2, 15000);
    const shownPanes = () =>
      ctx.page.evaluate(() =>
        [...document.querySelectorAll('.pane-layout-item[data-pane-id]')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => el.dataset.paneId)
          .sort()
          .join(','),
      );
    const sessionName = () =>
      ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.sessionName);
    const primaryPanes = await shownPanes();

    let created = null;
    try {
      await clickMenuItem(ctx.page, ['Session', 'New Session']);
      await waitForCondition(
        ctx.page,
        async () => {
          const name = await sessionName();
          if (name === primaryName || !/^tmuxy_\d+$/.test(name ?? '')) return false;
          created = name;
          return true;
        },
        20000,
        'the page to move to the session New Session made',
      );
      // tmux holds it — the page names it as soon as it switches, which can be
      // before tmux lists it — and the page shows its own single pane, not
      // the first's.
      await waitForCondition(
        ctx.page,
        async () => tmuxExec(`list-sessions -F '#{session_name}'`).split('\n').includes(created),
        15000,
        () => `tmux to list ${created}`,
      );
      await waitForCondition(
        ctx.page,
        async () => {
          const panes = await shownPanes();
          return panes !== '' && !panes.includes(',') && panes !== primaryPanes;
        },
        15000,
        "the new session's pane to be drawn",
      );

      // Back to the first session (the switcher's pick is the test above),
      // and it comes back with both its panes.
      await navigateToSession(ctx.page, primaryName);
      await waitForCondition(
        ctx.page,
        async () => (await sessionName()) === primaryName && (await shownPanes()) === primaryPanes,
        20000,
        'the first session and its two panes to come back',
      );
    } finally {
      if (created) tmuxExec(`kill-session -t ${created}`);
    }
  }, 120000);
});
