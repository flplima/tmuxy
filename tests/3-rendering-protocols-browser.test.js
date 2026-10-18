/**
 * Rendering & Protocols E2E Tests (The Browser Pane)
 *
 * `tmuxy browser` — a real Chromium browser drawn in a pane via inline images and SGR mouse reports.
 */

const path = require('path');
const {
  createTestContext,
  typeInTerminal,
  pressEnter,
  sendKeyCombo,
  waitForShellPrompt,
  waitForCondition,
} = require('./helpers');
const { startDebuggableBrowser } = require('./helpers/debuggable-browser');

const TMUXY_CLI = path.resolve(__dirname, '..', 'bin/tmuxy-cli');

// ==================== Scenario 24: The Browser Pane ====================

/**
 * `tmuxy browser` — a real browser drawn in a pane.
 *
 * The only test in the tree that exercises the whole chain this feature is:
 * an engine on the machine, its page encoded as an inline image, written to a
 * pty, carried through control mode, placed by the image parser and painted by
 * the client — and then a click going back the other way, from a real mouse
 * press on the rendered picture, through SGR mouse forwarding, to a page that
 * navigates. Nothing smaller can see it: the Rust tests prove the engine
 * answers and the unit tests prove the escape is well-formed, and either can be
 * true while the pane shows nothing.
 *
 * SKIPS when the machine has no Chromium-family browser, for the same reason
 * the Rust engine tests do: the engine is explicitly the user's own, and a
 * runner without one should not go red over a browser nobody installed. The
 * skip is loud.
 */
describe('Scenario 24: The Browser Pane', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  const fs = require('fs');
  const os = require('os');

  /** Where the fixture pages and the launcher live, cleaned up after. */
  const scratch = path.join(os.tmpdir(), `tmuxy-browser-e2e-${process.pid}`);

  /** The engine the pane would launch, or null with the reason printed. */
  function engineOrSkip() {
    const named = process.env.TMUXY_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (named && fs.existsSync(named)) return named;
    const usual = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    const found = usual.find((p) => fs.existsSync(p));
    if (found) return found;
    console.warn('SKIP Scenario 24: no Chromium-family browser on this machine');
    return null;
  }

  beforeAll(() => {
    fs.mkdirSync(scratch, { recursive: true });
    // Two pages, the first a single link filling the viewport. Filling it is
    // deliberate: a mouse report carries CELL coordinates, so a click lands at
    // a cell centre and a small target would make this a test of luck.
    fs.writeFileSync(
      path.join(scratch, 'first.html'),
      `<body style="margin:0"><a href="second.html"
         style="display:block;width:100vw;height:100vh;background:#4488ff">FIRST</a></body>`,
    );
    fs.writeFileSync(
      path.join(scratch, 'second.html'),
      `<body style="margin:0;background:#ffcc00"><h1>SECOND</h1></body>`,
    );
    // Typed as a short path rather than a long command line: typing a long
    // line into a pane drops characters often enough to run something else
    // (docs/PERFORMANCE.md says the same about the soak harness).
    fs.writeFileSync(
      path.join(scratch, 'run'),
      `#!/bin/sh\nexport TMUXY_STATE_DIR=${scratch}/state\n` +
        // The repo's CLI by path, not whatever `tmuxy` resolves to: a machine
        // may have an older one installed, and a test that runs it is testing
        // that instead.
        `exec ${TMUXY_CLI} browser --session e2e\n`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** What the pane is drawing right now, or null if it is drawing nothing. */
  async function readPicture(page) {
    return page.evaluate(() => {
      const img = document.querySelector('.terminal-image');
      if (!img) return null;
      const r = img.getBoundingClientRect();
      return {
        src: img.src,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        loaded: img.naturalWidth > 0,
      };
    });
  }

  /** The picture, once it is one the user could actually see. */
  async function waitForPicture(page, description) {
    await waitForCondition(
      page,
      async () => {
        const picture = await readPicture(page);
        // Visible, not merely present: an element clipped to nothing is not a
        // picture of a page (docs/TESTS.md).
        return !!picture && picture.loaded && picture.width > 20 && picture.height > 20;
      },
      60000,
      description,
    );
    return readPicture(page);
  }

  test('draws the page, forwards a click, and answers a verb on the status row [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    if (!engineOrSkip()) return;
    await ctx.setupPage();

    await typeInTerminal(ctx.page, `${scratch}/run`);
    await pressEnter(ctx.page);

    // The status row is for scripts and agents, read the way they read it —
    // `capture-pane` — since the app keeps a live browser's text out of sight.
    const captured = () => String(ctx.session.runCommand(`capture-pane -p -t ${ctx.session.name}`));
    const waitForStatus = (text, budget) =>
      waitForCondition(
        ctx.page,
        () => captured().includes(text),
        budget,
        () =>
          `\`${text}\` in the captured pane (now: ${JSON.stringify(captured().trim().slice(-120))})`,
      );

    // The status row ends up showing where the pane is pointed, which for a
    // session nobody has navigated is `about:blank`. Waiting for THAT rather
    // than the banner, because the banner is the first thing the URL replaces.
    await waitForStatus('about:blank', 60000);

    await typeInTerminal(ctx.page, `:goto file://${scratch}/first.html`);
    await pressEnter(ctx.page);
    await waitForStatus('first.html', 60000);

    const picture = await waitForPicture(ctx.page, 'the first page is drawn in the pane');

    // The grid under the picture — toolbar header, status row — is not for the
    // person looking at the page: none of its text is visible.
    const gridShown = await ctx.page.evaluate(() => {
      const grid = document.querySelector('.terminal-content');
      return grid ? getComputedStyle(grid).visibility : null;
    });
    expect(gridShown).toBe('hidden');

    // The first page has nothing behind it: the engine's starting
    // `about:blank` is not somewhere to go back to.
    const backButton = () =>
      ctx.page.evaluate(() => {
        const button = document.querySelector(
          '[data-testid="browser-live-bar"] [data-testid="browser-nav-back"]',
        );
        return button ? { disabled: button.disabled } : null;
      });
    await waitForCondition(
      ctx.page,
      async () => (await backButton())?.disabled === true,
      30000,
      async () => `Back to be off on the first page (now ${JSON.stringify(await backButton())})`,
    );

    // A real click on the picture. It goes out as an SGR mouse report, which
    // is the same path any mouse-tracking program in a pane gets — nothing
    // about this feature is in the client.
    await ctx.page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);

    // The picture changes, which is the click having landed: the second page
    // is a different colour, so a new frame is drawn and served under a new
    // image id. Waiting on THAT rather than on a delay, because how long an
    // engine takes to follow a link is exactly the kind of constant that
    // passes here and fails on a slower runner.
    await waitForCondition(
      ctx.page,
      async () => {
        const now = await readPicture(ctx.page);
        return !!now && now.loaded && now.src !== picture.src;
      },
      60000,
      'the click reaches the page and it repaints',
    );

    // And the page followed the LINK rather than merely repainting. Asked
    // through the verb line, because the answer prints on the status row —
    // which is also how an agent reads it, with `tmuxy pane capture`.
    await typeInTerminal(ctx.page, ':url');
    await pressEnter(ctx.page);
    await waitForStatus('second.html', 30000);

    // A verb that computes rather than navigates, so the status row is shown
    // to carry real output and not just URLs.
    await typeInTerminal(ctx.page, ':eval 6*7');
    await pressEnter(ctx.page);
    await waitForStatus('42', 30000);

    // The address bar over the top row: on screen, and showing where the PAGE
    // is — the link was followed inside it, and the bar followed too.
    const readBar = () =>
      ctx.page.evaluate(() => {
        const bar = document.querySelector('[data-testid="browser-live-bar"]');
        const input = bar?.querySelector('[data-testid="browser-nav-input"]');
        if (!bar || !input) return null;
        const r = bar.getBoundingClientRect();
        return { width: r.width, height: r.height, address: input.value };
      });
    await waitForCondition(
      ctx.page,
      async () => {
        const bar = await readBar();
        return !!bar && bar.width > 0 && bar.height > 0 && bar.address.endsWith('second.html');
      },
      30000,
      async () =>
        `the address bar to show the followed link (bar: ${JSON.stringify(await readBar())})`,
    );

    // Its back button drives the pane, and the bar follows the page back.
    await ctx.page.click('[data-testid="browser-live-bar"] [data-testid="browser-nav-back"]');
    await waitForCondition(
      ctx.page,
      async () => (await readBar())?.address.endsWith('first.html') ?? false,
      30000,
      async () => `the back button to take the page back (bar: ${JSON.stringify(await readBar())})`,
    );

    // The page-size button: Mobile draws a phone-shaped page at its own
    // aspect, a narrow column in the pane; Auto gives the pane back to it.
    const pictureShape = () =>
      ctx.page.evaluate(() => {
        const img = document.querySelector('.terminal-image');
        if (!img) return null;
        const r = img.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
    const choose = async (label) => {
      await ctx.page.click('[data-testid="browser-nav-viewport"]');
      await ctx.page.click(`[data-testid="browser-viewport-menu"] >> text=${label}`);
    };
    await choose('Mobile (400x800px)');
    await waitForCondition(
      ctx.page,
      async () => {
        const shape = await pictureShape();
        return !!shape && shape.height > 0 && shape.width < shape.height;
      },
      30000,
      async () => `a phone-shaped picture (now ${JSON.stringify(await pictureShape())})`,
    );
    await choose('Auto');
    await waitForCondition(
      ctx.page,
      async () => {
        const shape = await pictureShape();
        return !!shape && shape.width > shape.height;
      },
      30000,
      async () =>
        `the picture to fill the pane again (now ${JSON.stringify(await pictureShape())})`,
    );

    // Leaving gives the shell back: the alternate screen goes away and the
    // pane is a shell again, not a frozen picture — with no bar over it.
    await sendKeyCombo(ctx.page, 'Control', 'c');
    await waitForShellPrompt(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => (await readBar()) === null,
      15000,
      'the address bar to leave with the browser',
    );
  }, 180000);

  /**
   * `--attach`: the same pane on a browser somebody else started. What is
   * different, and so what is tested: the page drawn is the browser's OWN tab,
   * the browser outlives the pane, and the REPL button swaps the picture for
   * the verb log — which is where a person sees what an agent typed.
   */
  test('attaches to a running browser, draws its tab, and the REPL button shows the log [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    const engine = engineOrSkip();
    if (!engine) return;
    await ctx.setupPage();

    // A browser started the way anyone starts one for remote debugging: a
    // profile of its own and a kernel-chosen port, announced in the profile's
    // DevToolsActivePort — the file `--attach` reads when given no endpoint.
    const profile = path.join(scratch, 'attach-profile');
    const browser = startDebuggableBrowser(engine, profile);
    try {
      const portFile = path.join(profile, 'DevToolsActivePort');
      await waitForCondition(
        ctx.page,
        () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim().length > 0,
        60000,
        'the browser to announce its DevTools port',
      );
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      fs.writeFileSync(
        path.join(scratch, 'attach'),
        `#!/bin/sh\nexport TMUXY_STATE_DIR=${scratch}/state\n` +
          `exec ${TMUXY_CLI} browser --attach=http://127.0.0.1:${port}\n`,
        { mode: 0o755 },
      );

      await typeInTerminal(ctx.page, `${scratch}/attach`);
      await pressEnter(ctx.page);

      const captured = () =>
        String(ctx.session.runCommand(`capture-pane -p -t ${ctx.session.name}`));
      const waitForStatus = (text, budget) =>
        waitForCondition(
          ctx.page,
          () => captured().includes(text),
          budget,
          () =>
            `\`${text}\` in the captured pane (now: ${JSON.stringify(captured().trim().slice(-120))})`,
        );
      await waitForStatus('about:blank', 60000);

      await typeInTerminal(ctx.page, `:goto file://${scratch}/second.html`);
      await pressEnter(ctx.page);
      await waitForStatus('second.html', 60000);

      // The attached tab is drawn in the pane, as a launched one is.
      await waitForPicture(ctx.page, "the attached browser's page is drawn in the pane");

      // And it is the browser's own tab that moved, not a second one.
      await waitForCondition(
        ctx.page,
        async () => {
          const res = await fetch(`http://127.0.0.1:${port}/json/list`);
          const tabs = await res.json();
          return tabs.some((t) => t.type === 'page' && t.url.endsWith('second.html'));
        },
        30000,
        "the browser's own tab to be on the page",
      );

      // The REPL button: the log replaces the picture, as text the person can
      // read — the grid, hidden under a picture, is shown for this.
      const gridVisibility = () =>
        ctx.page.evaluate(() => {
          const grid = document.querySelector('.terminal-content');
          return grid ? getComputedStyle(grid).visibility : null;
        });
      const replButton = () =>
        ctx.page.evaluate(() => {
          const button = document.querySelector('[data-testid="browser-nav-repl"]');
          if (!button) return null;
          const r = button.getBoundingClientRect();
          return { pressed: button.getAttribute('aria-pressed'), width: r.width, height: r.height };
        });
      await waitForCondition(
        ctx.page,
        async () => {
          const button = await replButton();
          return !!button && button.width > 0 && button.height > 0 && button.pressed === 'false';
        },
        30000,
        async () => `a REPL button, off (now ${JSON.stringify(await replButton())})`,
      );
      await ctx.page.click('[data-testid="browser-nav-repl"]');
      await waitForCondition(
        ctx.page,
        async () =>
          (await replButton())?.pressed === 'true' && (await gridVisibility()) === 'visible',
        30000,
        async () =>
          `the REPL view to be up (button ${JSON.stringify(await replButton())}, grid ${await gridVisibility()})`,
      );
      // The log carries what was typed and what came back, visibly: the verb
      // line is text on screen now, with real size, not a captured row.
      const logLine = () =>
        ctx.page.evaluate(() => {
          const lines = [...document.querySelectorAll('.terminal-content .terminal-line')];
          const line = lines.find((l) => l.textContent.includes(':goto file://'));
          if (!line) return null;
          const r = line.getBoundingClientRect();
          return { width: r.width, height: r.height };
        });
      await waitForCondition(
        ctx.page,
        async () => {
          const line = await logLine();
          return !!line && line.width > 0 && line.height > 0;
        },
        30000,
        'the verb log to show the goto line',
      );
      expect(await readPicture(ctx.page)).toBeNull();

      // And back: the picture returns on its own, the grid goes under it.
      await ctx.page.click('[data-testid="browser-nav-repl"]');
      await waitForPicture(ctx.page, 'the page is drawn again after the REPL view');
      await waitForCondition(
        ctx.page,
        async () => (await gridVisibility()) === 'hidden',
        30000,
        'the grid to hide under the picture again',
      );

      // Leaving the pane leaves the browser: it was not tmuxy's to close.
      await sendKeyCombo(ctx.page, 'Control', 'c');
      await waitForShellPrompt(ctx.page);
      expect(browser.exitCode).toBeNull();
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      expect(res.ok).toBe(true);
    } finally {
      browser.kill();
    }
  }, 180000);
});
