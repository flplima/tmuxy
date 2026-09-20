/**
 * A test context for a browser context this suite OWNS.
 *
 * `createTestContext()` (test-setup.js) hands every suite the same thing: one
 * shared Chromium, one 1280x720 context, no touch. Two kinds of bug are
 * invisible to that browser and only to that browser:
 *
 * - **Engine.** WebKit collapses the document's selection whenever focus
 *   moves; Blink leaves it alone. Every selection, copy and focus bug the
 *   desktop app has shipped came from that one difference, and CI's Chromium
 *   cannot fail for it (the Tauri suite is Linux/WebKitGTK only, macOS
 *   WKWebView has no functional suite at all).
 * - **Context options.** `hasTouch` and a phone-sized viewport are properties
 *   of a browser CONTEXT, so a suite that needs them has to open its own.
 *
 * This factory is the lifecycle of `createTestContext` — tmux session per
 * test, navigate, verified round trip, teardown that waits for the monitor —
 * around a context the caller opens. It does not replace `createTestContext`;
 * anything that fits the shared browser should keep using it.
 */

const {
  waitForServer,
  navigateToSession,
  verifyRoundTrip,
  focusPage,
  waitForSessionReady,
  acknowledgeRiskNotice,
  delay,
} = require('./browser');
const TmuxTestSession = require('./TmuxTestSession');
const { TMUXY_URL, DELAYS } = require('./config');
const { tmuxExec } = require('./tmux-socket');

/**
 * @param {Object} options
 * @param {() => Promise<import('playwright').Browser>} options.openBrowser
 *   Opens the browser this suite drives. Throwing means "this engine is not
 *   installed here" when `optional` is set.
 * @param {Object} [options.contextOptions] Passed to `browser.newContext()`.
 * @param {string} options.label What is being driven, for skip messages
 *   ("Playwright WebKit").
 * @param {boolean} [options.optional=false] When the browser cannot be opened:
 *   `false` fails the suite (the default everywhere else in this repo), `true`
 *   warns loudly and lets `skipIfUnavailable()` return true — for an engine
 *   the project forbids installing locally (docs/TESTS.md). `requireEnv`
 *   turns the warning back into a failure.
 * @param {string} [options.requireEnv] Env var that forces `optional` off.
 */
function createOwnBrowserContext({
  openBrowser,
  contextOptions = {},
  label,
  optional = false,
  requireEnv,
}) {
  const ctx = {
    browser: null,
    context: null,
    page: null,
    session: null,
    serverAvailable: true,
    browserError: null,
  };

  const required = () => !optional || Boolean(requireEnv && process.env[requireEnv]);

  ctx.hookTimeout = 60000;

  ctx.beforeAll = async () => {
    try {
      await waitForServer(TMUXY_URL, 10000);
    } catch {
      ctx.serverAvailable = false;
      return;
    }
    try {
      ctx.browser = await openBrowser();
    } catch (err) {
      // Keep the cause. Without it the suite reports green in milliseconds and
      // nothing says whether the engine is missing or the launch is broken.
      ctx.browserError = String(err.message || err).split('\n')[0];
    }
  };

  ctx.afterAll = async () => {
    if (ctx.page) await ctx.page.close().catch(() => {});
    if (ctx.context) await ctx.context.close().catch(() => {});
    if (ctx.browser) await ctx.browser.close().catch(() => {});
    ctx.browser = null;
  };

  ctx.beforeEach = async () => {
    if (!ctx.browser) return;
    ctx.session = new TmuxTestSession();
    ctx.session.create();
    ctx.context = await ctx.browser.newContext(contextOptions);
    await acknowledgeRiskNotice(ctx.context);
    ctx.page = await ctx.context.newPage();
  };

  ctx.afterEach = async () => {
    if (ctx.session && ctx.page) {
      try {
        await ctx.session.destroy();
      } catch {
        // The server cleans the session up when the last client leaves.
      }
    }
    if (ctx.page) {
      await ctx.page.close().catch(() => {});
      ctx.page = null;
    }
    if (ctx.context) {
      await ctx.context.close().catch(() => {});
      ctx.context = null;
    }
    const name = ctx.session?.name;
    ctx.session = null;
    await waitForMonitorGone(name);
  };

  /**
   * Wait until the server's control-mode monitor has let go of tmux, so the
   * next test does not connect while the previous session is still attached.
   * tmux itself is the signal: the session is gone and no client is left.
   */
  async function waitForMonitorGone(session, timeout = 10000) {
    if (!session) return await delay(DELAYS.LONG);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let clients = '';
      try {
        // A throw means "no such session", which is the state being waited for.
        tmuxExec(`has-session -t ${session}`, { timeout: 2000 });
        clients = tmuxExec(`list-clients -t ${session} -F '#{client_name}'`, { timeout: 2000 });
      } catch {
        clients = '';
      }
      if (clients.trim() === '') return await delay(DELAYS.LONG);
      await delay(100);
    }
  }

  ctx.isReady = () => Boolean(ctx.serverAvailable && ctx.browser && ctx.page);

  /**
   * True when the suite cannot run and is allowed not to. Loud either way:
   * a silent skip is indistinguishable from a pass, which is the failure mode
   * docs/TESTS.md exists to prevent.
   */
  ctx.skipIfUnavailable = () => {
    if (ctx.isReady()) return false;
    const reason = !ctx.serverAvailable
      ? `the tmuxy server is not reachable at ${TMUXY_URL}`
      : `${label} could not be launched` +
        (ctx.browserError ? `\n   cause: ${ctx.browserError}` : '');
    if (!ctx.serverAvailable || required()) {
      throw new Error(`${label} suite cannot run: ${reason}`);
    }
    console.warn(
      [
        '',
        '='.repeat(72),
        `SKIPPED — ${label} is not available on this machine.`,
        `  ${reason}`,
        '  Nothing in this suite ran. It is written to run for real wherever the',
        `  browser exists (CI provisions its own); set ${requireEnv}=1 to turn this`,
        '  skip into a failure.',
        '='.repeat(72),
        '',
      ].join('\n'),
    );
    return true;
  };

  /** Navigate to this test's session and put the keyboard in the terminal. */
  ctx.setupPage = async () => {
    await navigateToSession(ctx.page, ctx.session.name);
    await waitForSessionReady(ctx.page, ctx.session.name);
    await verifyRoundTrip(ctx.page, ctx.session.name);
    ctx.session.setPage(ctx.page);
    await ctx.session.sourceConfig();
    await focusPage(ctx.page);
  };

  return ctx;
}

module.exports = { createOwnBrowserContext };
