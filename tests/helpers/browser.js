/**
 * Browser Helpers
 *
 * Playwright setup and browser interaction utilities
 */

const { chromium } = require('playwright');
const { CDP_PORT, TMUXY_URL, WAIT_SCALE, waitBudget } = require('./config');

/**
 * Sleep. The number is restated for this machine the way every wait budget
 * is (`waitBudget`): a beat measured on one laptop is the same beat on a slow
 * runner, scaled with the budgets around it rather than fixed while they grow.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, waitBudget(ms)));
}

/**
 * Launch a fresh headless browser for tests
 */
// Shared browser instance — launched once via Playwright, reused across all test
// suites in the same Jest run. Never closed until the process exits.
let sharedBrowser = null;

async function getBrowser() {
  if (!sharedBrowser) {
    // Try CDP connection first (external Chrome with --remote-debugging-port)
    try {
      sharedBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      sharedBrowser.on('disconnected', () => {
        sharedBrowser = null;
      });
    } catch {
      // No external Chrome — launch our own headless instance. On platforms
      // without a Playwright-bundled Chromium (e.g. arm64), point Playwright at
      // the system chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; unset falls
      // back to the bundled binary.
      sharedBrowser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      sharedBrowser.on('disconnected', () => {
        sharedBrowser = null;
      });
    }
  }

  return {
    _browser: sharedBrowser,
    async newPage() {
      const context = await sharedBrowser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      page._context = context;
      page.once('close', () => {
        context.close().catch(() => {});
      });
      await instrumentPage(page);
      return page;
    },
    async close() {
      // No-op — shared browser persists across suites (see disconnectBrowser).
    },
  };
}

/** Slow the page down when asked to and print its own problems into the test output. */
async function instrumentPage(page) {
  await throttleCpu(page);
  surfacePageProblems(page);
}

/**
 * Print the page's own errors and warnings into the test output.
 *
 * A failing assertion says what the DOM or the machine looked like; it cannot
 * say why. The one place the app explains itself — an uncaught error, a
 * `console.warn` on a path that should not have run — was being thrown away,
 * so a flake that was a product bug read as a timing problem in the test.
 * Errors and warnings only: the app's `console.log` traffic is not evidence.
 */
function surfacePageProblems(page) {
  // Straight to stderr: through `console`, jest decorates every line with the
  // source frame of THIS function, which is noise that buries the message.
  const say = (line) => process.stderr.write(`${line}\n`);
  page.on('pageerror', (error) => say(`[page error] ${error.message}`));
  page.on('console', (message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') return;
    // The browser logs every refused resource as a console error. A suite that
    // proves a request is refused (an unlisted `Host`, SEC-15) produces those
    // on purpose, and they are the network log talking, not the app.
    if (message.text().startsWith('Failed to load resource')) return;
    say(`[page ${type}] ${message.text()}`);
  });
}

/**
 * Slow the page's renderer down by `TMUXY_E2E_CPU_THROTTLE` (a factor; unset or
 * 1 means none).
 *
 * The same knob the storybook probe has (`PROBE_CPU_THROTTLE`), for the same
 * reason: a CI runner is several times slower than a dev machine, and that is
 * where a wait that assumes something has already happened fails. A race that
 * passes here a hundred times out of a hundred can fail there on the first
 * run; throttling the renderer is how to see it on this machine. Chromium only
 * (a CDP emulation call) — a run on anything else gets no throttle and says so.
 */
async function throttleCpu(page) {
  const rate = Number(process.env.TMUXY_E2E_CPU_THROTTLE || 1);
  if (!(rate > 1)) return;
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate });
  } catch (error) {
    console.warn(`TMUXY_E2E_CPU_THROTTLE=${rate} ignored: ${error.message}`);
  }
}

/**
 * Let go of the shared browser at the end of a run.
 *
 * It is kept alive across suites, so it is the one open handle left when the
 * last suite ends. A CDP connection is only disconnected (the browser is the
 * user's, or CI's); a browser this process launched is closed.
 */
async function disconnectBrowser() {
  if (!sharedBrowser) return;
  const browser = sharedBrowser;
  sharedBrowser = null;
  try {
    if (browser.isConnected?.() !== false) {
      await browser.close();
    }
  } catch {
    // Already gone — nothing to release.
  }
}

/** Wait until the server at `url` answers. */
async function waitForServer(url = TMUXY_URL, timeout = 30000) {
  await waitForCondition(
    null,
    () =>
      fetch(url, { signal: AbortSignal.timeout(2000) }).then(
        (response) => response.ok,
        () => false,
      ),
    timeout,
    `the server at ${url} to answer`,
  );
}

/** What the page's terminals show, joined; empty when it cannot be read. */
function terminalText(page) {
  return page
    .evaluate(() =>
      [...document.querySelectorAll('[role="log"]')].map((l) => l.textContent || '').join('\n'),
    )
    .then((text) => text.slice(0, 300))
    .catch(() => '');
}

/**
 * Click a terminal where its cursor is (on its bottom row without one), the
 * way a user clicks to type: anywhere else can be a hyperlink, which a click
 * opens. A spot something else covers (the dock's resize handle lies over
 * its terminal's left edge) is skipped for the next one along the row.
 */
async function clickTerminal(terminal) {
  const position = await terminal.evaluate(
    (log) => {
      const box = log.getBoundingClientRect();
      const cursor = log.querySelector('.terminal-cursor')?.getBoundingClientRect();
      const bottom = Math.max(1, box.height - 4);
      const spots = [
        ...(cursor && cursor.width > 0
          ? [
              {
                x: cursor.left - box.left + cursor.width / 2,
                y: cursor.top - box.top + cursor.height / 2,
              },
            ]
          : []),
        ...[4, 16, box.width / 4, box.width / 2].map((x) => ({ x, y: bottom })),
      ];
      const reaches = ({ x, y }) =>
        log.contains(document.elementFromPoint(box.left + x, box.top + y));
      return spots.find(reaches) ?? spots[0];
    },
    undefined,
    { timeout: 5000 },
  );
  await terminal.click({ position, timeout: 5000 });
}

/**
 * Click into a terminal (the page, without one) and wait for the app to hold
 * the keyboard. On a touchscreen a click does not hand it over (a tap on the
 * pane does, which is what the touch suites test), so it is not waited for.
 */
async function focusPage(page, { touch = false } = {}) {
  // A locator, not an element handle, so a re-render between finding the
  // terminal and clicking it does not detach the target.
  try {
    await clickTerminal(page.locator('[role="log"]').first());
  } catch {
    await page.click('body', { timeout: 5000 });
  }
  if (!touch) await waitForKeyboardFocus(page);
}

/**
 * Wait until the app is really holding the keyboard: the hidden 1px `<input>`
 * it keeps focused on every device (infra/dom/mobileKeyboard.ts) is the active
 * element, so a keystroke reaches a pane. "The clicked terminal is the active
 * element" is true the instant the click lands, before the app has taken focus,
 * and the first characters of a long command were then typed into nothing.
 */
async function waitForKeyboardFocus(page, timeout = 3000) {
  await waitForCondition(
    page,
    () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      }),
    timeout,
    async () =>
      `the app to hold the keyboard (the focus is on ${await page
        .evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? 'nothing')
        .catch(() => 'a page that cannot be read')})`,
  );
}

/** Wait until the strip shows `expectedCount` tabs; throw past the budget with what it shows. */
async function waitForWindowCount(page, expectedCount, timeout = 10000) {
  const budget = waitBudget(timeout);
  try {
    await page.waitForFunction(
      (count) => {
        const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
        return tabs.length === count;
      },
      expectedCount,
      { timeout: budget, polling: 50 },
    );
  } catch {
    const diag = await page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
      const tabInfo = Array.from(tabs).map((t) =>
        t.querySelector('button')?.getAttribute('aria-label'),
      );
      const windows = window.app?.view().windows.map((w) => `${w.id}:${w.kind}`);
      return { count: tabs.length, tabInfo, windows };
    });
    throw new Error(
      `Expected ${expectedCount} window tabs, found ${diag.count} (timeout ${budget}ms)\n  DOM tabs: ${JSON.stringify(diag.tabInfo)}\n  client windows: ${JSON.stringify(diag.windows)}`,
    );
  }
}

/**
 * Resolve after the page has drawn `frames` more frames. For a check that
 * something did NOT change after a local interaction (a scroll, a click that
 * re-renders): the app reacts in the event handler and on the next frame, so
 * a couple of painted frames is the moment a change would have shown — tied
 * to the page's own clock, not a number of milliseconds.
 */
async function afterFrames(page, frames = 2) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const step = (left) =>
          left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(n);
      }),
    frames,
  );
}

/**
 * Poll `fn` until it returns something truthy, and return that; throw past
 * the budget, with `description` (a string, or a function for one computed
 * at the time of failure).
 */
async function waitForCondition(page, fn, timeout = 10000, description = 'condition') {
  // The caller's number says how long this SHOULD take on the machine it was
  // written on; `waitBudget` restates it for the machine it is running on.
  const budget = waitBudget(timeout);
  const start = Date.now();
  while (Date.now() - start < budget) {
    const value = await fn();
    if (value) return value;
    // The gap between looks is not scaled: a slow machine gets more of the
    // budget, not a condition noticed later than it held.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const desc = typeof description === 'function' ? await description() : description;
  const scaled = budget === timeout ? '' : `, ${timeout}ms x${WAIT_SCALE}`;
  throw new Error(`Timed out waiting for ${desc} (${budget}ms${scaled})`);
}

/**
 * Wait until the app has caught up with everything sent so far: tmux has done
 * it, its notifications have reached the store and the screen has painted them
 * (`window.app.caughtUp()`, AppProvider). It is the question a
 * `delay(DELAYS.SYNC)` after a click or a prefix key was guessing at, answered
 * the moment the round trip is over, and waited for when it takes longer.
 *
 * It says nothing about a PROGRAM in a pane, whose output arrives whenever it
 * does; that is `waitForTerminalText`'s question.
 */
async function waitForSettled(page, timeout = 10000) {
  const budget = waitBudget(timeout);
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), budget);
  });
  const caughtUp = page.evaluate(() => window.app.caughtUp().then(() => true));
  try {
    if (!(await Promise.race([caughtUp, deadline]))) {
      throw new Error(
        `Timed out waiting for the app to catch up (${budget}ms): a command in flight, a ` +
          'pending op or an unapplied state kept it busy',
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  waitForSettled,
  afterFrames,
  disconnectBrowser,
  delay,
  getBrowser,
  instrumentPage,
  waitForServer,
  terminalText,
  clickTerminal,
  focusPage,
  waitForKeyboardFocus,
  waitForWindowCount,
  waitForCondition,
};
