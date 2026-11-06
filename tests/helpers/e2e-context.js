/**
 * The E2E test context: a `describe` that owns its hooks, its browser and its
 * failure.
 *
 *   describeE2E('Scenario 4d: Marked pane', {}, (ctx) => {
 *     test('...', async () => {
 *       await ctx.setupPage();
 *       ...ctx.page, ctx.session...
 *     });
 *   });
 *
 * Every test gets a fresh tmux session (created by the server when the page
 * opens it) and a fresh page, and its teardown waits for the server to let go
 * of the session. A missing server or browser fails the suite in `beforeAll`:
 * a suite that skips when they are missing reports green having run nothing.
 *
 * Options:
 * - `snapshot`: compare the UI with tmux after each test (rendering suites).
 * - `context`: options for a browser context of the suite's own in the shared
 *   Chromium (`hasTouch`, a phone's viewport), since those are properties of a
 *   context, not a page.
 * - `browser: 'webkit'`: Playwright WebKit, the proxy CI has for the desktop
 *   app's WKWebView. The project forbids installing Playwright browsers
 *   locally (docs/TESTS.md), so where it is absent the suite is reported as a
 *   todo, loudly; `TMUXY_E2E_REQUIRE_WEBKIT=1` (set in CI) makes that a failure.
 */

const fs = require('fs');
const { webkit } = require('playwright');
const {
  getBrowser,
  instrumentPage,
  waitForServer,
  focusPage,
  waitForCondition,
  terminalText,
} = require('./browser');
const TmuxTestSession = require('./TmuxTestSession');
const { TMUXY_URL, waitBudget } = require('./config');
const { GlitchDetector } = require('./glitch-detector');
const { waitForMonitorGone, waitForMonitorAttached } = require('./monitor');
const { assertScreenMatchesTmux } = require('./ui-tmux');
const { splitPaneKeyboard, waitForShellPrompt } = require('./pane-ops');
const { tmuxSideOfSession } = require('./tmux-side');
const { tmuxCmd } = require('./tmux-socket');

const HOOK_TIMEOUT = 60000;

/**
 * Open `sessionName` in `page` and wait until it can be typed into: the app
 * names an active pane, the server's monitor is attached to the session, and a
 * shell prompt is the last thing in a terminal (unless every pane shows a
 * widget). Throws with what the page and tmux show.
 */
async function openSession(page, sessionName, tmuxyUrl = TMUXY_URL) {
  const url = `${tmuxyUrl}?session=${encodeURIComponent(sessionName)}`;
  const why = (what) => async () =>
    `${what} for '${sessionName}'\nthe page shows: ${JSON.stringify(await terminalText(page))}\n` +
    (await tmuxSideOfSession(page, sessionName));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: waitBudget(30000) });
  await waitForCondition(
    page,
    () =>
      page
        .evaluate(
          () =>
            Boolean(window.app?.view?.().activePaneId) &&
            document.querySelector('.pane-layout-item[data-pane-id]') !== null,
        )
        .catch(() => false),
    30000,
    why('openSession: the app to draw a pane'),
  );
  await waitForMonitorAttached(sessionName);
  const widgetsOnly = await page.evaluate(
    () =>
      document.querySelectorAll('[role="log"]').length === 0 &&
      [...document.querySelectorAll('.pane-layout-item[data-pane-id]')].every(
        (pane) => pane.querySelector('[class*="widget"]') !== null,
      ),
  );
  if (!widgetsOnly) await waitForShellPrompt(page);
  return url;
}

/**
 * Start the tmux server on the suite's socket when it is not running. A
 * stress test can crash an older tmux, and booting the server recovers it.
 *
 * A session has to be created and destroyed, not just the server started:
 * `start-server` alone made the suite intermittently fail with a pane whose
 * shell never wrote a byte. Its process must not be a shell: a shell killed
 * during `init_io` blocks forever in the kernel opening a tty slave whose
 * master tmux has already closed (see
 * `packages/tmuxy-cli/bin/tmuxy/reap-orphan-shells`); `tail -f /dev/null`
 * never opens a terminal.
 */
function ensureTmuxServer() {
  const { execSync } = require('child_process');
  try {
    execSync(`${tmuxCmd()} has-session 2>/dev/null`, { timeout: 5000 });
  } catch {
    execSync(
      `${tmuxCmd()} new-session -d -s _warmup 'tail -f /dev/null' && ` +
        `${tmuxCmd()} kill-session -t _warmup`,
      { timeout: 10000, encoding: 'utf-8' },
    );
  }
}

/** Whether the suite's browser can run here; a reason when it cannot. */
function unavailableReason(browser) {
  if (browser !== 'webkit') return null;
  if (fs.existsSync(webkit.executablePath())) return null;
  return 'Playwright WebKit is not installed on this machine';
}

function describeE2E(name, options, fn) {
  const { snapshot = false, context: contextOptions = null, browser = 'chromium' } = options;

  const missing = unavailableReason(browser);
  if (missing && !process.env.TMUXY_E2E_REQUIRE_WEBKIT) {
    describe(name, () => {
      console.warn(
        `\n${'='.repeat(72)}\nNOT RUN — ${name}: ${missing}.\n` +
          '  It runs for real wherever the browser exists (CI provisions its own);\n' +
          `  TMUXY_E2E_REQUIRE_WEBKIT=1 makes this a failure.\n${'='.repeat(72)}\n`,
      );
      test.todo(`${name} (not run: ${missing})`);
    });
    return;
  }

  describe(name, () => {
    const ctx = {
      browser: null,
      context: null,
      page: null,
      session: null,
      glitchDetector: null,
    };
    // A browser this suite launched is closed with it; the shared Chromium is not.
    let ownsBrowser = false;

    beforeAll(async () => {
      if (missing) throw new Error(`${name} cannot run: ${missing}`);
      await waitForServer(TMUXY_URL, 10000);
      if (browser === 'webkit') {
        ctx.browser = await webkit.launch({ headless: true });
        ownsBrowser = true;
      } else {
        ctx.browser = (await getBrowser())._browser;
      }
    }, HOOK_TIMEOUT);

    beforeEach(async () => {
      ensureTmuxServer();
      ctx.session = new TmuxTestSession();
      if (contextOptions || browser !== 'chromium') {
        ctx.context = await ctx.browser.newContext(
          contextOptions ?? { viewport: { width: 1280, height: 720 } },
        );
        ctx.page = await ctx.context.newPage();
        await instrumentPage(ctx.page);
      } else {
        ctx.page = await (await getBrowser()).newPage();
      }
    }, HOOK_TIMEOUT);

    /** Open this test's session, load the tmuxy config into it, and put the keyboard in a terminal. */
    ctx.setupPage = async () => {
      await openSession(ctx.page, ctx.session.name);
      ctx.session.setPage(ctx.page);
      await ctx.session.sourceConfig();
      await focusPage(ctx.page, { touch: Boolean(contextOptions?.hasTouch) });
    };

    /** `setupPage`, then split the pane in two through the keyboard. */
    ctx.setupTwoPanes = async (direction = 'horizontal') => {
      await ctx.setupPage();
      await splitPaneKeyboard(ctx.page, direction);
      await waitForCondition(
        ctx.page,
        async () => (await ctx.session.getPaneCount()) === 2,
        10000,
        'setupTwoPanes: the tab to hold 2 panes',
      );
    };

    /** Start recording glitches; the teardown asserts there were none. */
    ctx.startGlitchDetection = async (detectorOptions = {}) => {
      ctx.glitchDetector = new GlitchDetector(ctx.page);
      await ctx.glitchDetector.start(detectorOptions);
      return ctx.glitchDetector;
    };

    /** Stop recording glitches and assert there were none. */
    ctx.assertNoGlitches = async (assertOptions = {}) => {
      const result = await ctx.glitchDetector.assertNoGlitches(assertOptions);
      ctx.glitchDetector = null;
      return result;
    };

    ctx.hookTimeout = HOOK_TIMEOUT;

    // The suite's own hooks are registered between these: its before-hooks
    // run after the context's set-up, its after-hooks before the teardown.
    fn(ctx);

    afterEach(async () => {
      // Every step runs whatever an earlier one threw: a session left attached
      // makes the next test's `new-session` crash tmux 3.5a. The first failure
      // is the one reported.
      const failures = [];
      const step = async (run) => {
        try {
          await run();
        } catch (error) {
          failures.push(error);
        }
      };
      if (snapshot && ctx.page) await step(() => assertScreenMatchesTmux(ctx.page));
      if (ctx.glitchDetector?.isRunning) {
        await step(() => ctx.glitchDetector.assertNoGlitches({ operation: 'test' }));
      }
      ctx.glitchDetector = null;
      const sessionName = ctx.session?.name;
      if (ctx.session) await step(() => ctx.session.destroy());
      if (ctx.page) await step(() => ctx.page.close());
      if (ctx.context) await step(() => ctx.context.close());
      ctx.page = null;
      ctx.context = null;
      ctx.session = null;
      await step(() => waitForMonitorGone(sessionName));
      if (failures.length > 0) throw failures[0];
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      if (ownsBrowser) await ctx.browser?.close();
      ctx.browser = null;
    }, HOOK_TIMEOUT);
  });
}

module.exports = { describeE2E, openSession };
