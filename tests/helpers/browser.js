/**
 * Browser Helpers
 *
 * Playwright setup and browser interaction utilities
 */

const { chromium } = require('playwright');
const { CDP_PORT, TMUXY_URL, DELAYS, WAIT_SCALE, waitBudget } = require('./config');
const { tmuxExec } = require('./tmux-socket');
const { tmuxSideOfSession } = require('./tmux-side');

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
      await throttleCpu(page);
      surfacePageProblems(page);
      return page;
    },
    async close() {
      // No-op — shared browser persists across suites (see disconnectBrowser).
    },
  };
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
    // proves a route is refused (the read-only server, SEC-11) produces those
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
 * It is deliberately kept alive across suites, which leaves one open handle
 * when the last suite ends — the handle `--forceExit` used to paper over. A
 * CDP connection is only disconnected (the browser is the user's, or CI's);
 * a browser this process launched is closed.
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

/**
 * Wait for tmuxy server to be ready
 */
async function waitForServer(url = TMUXY_URL, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await delay(500);
  }
  throw new Error(`Server at ${url} not ready after ${timeout}ms`);
}

/**
 * Navigate to tmuxy with session parameter.
 * Includes retry logic for SSE connection race conditions and a verified
 * round-trip readiness gate: sends a unique marker command through tmux
 * and waits for it to appear in the DOM before returning.
 */
async function navigateToSession(page, sessionName, tmuxyUrl = TMUXY_URL) {
  const url = `${tmuxyUrl}?session=${encodeURIComponent(sessionName)}`;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // A drawn pane — a terminal, or a widget where the pane shows one.
      // Attached, not visible: the check below reads the text, and a
      // read-only viewer's grid is scaled to fit its window, which Playwright
      // does not always count as visible while it settles.
      await page.waitForSelector('.pane-layout-item[data-pane-id]', {
        state: 'attached',
        timeout: 10000,
      });
    } catch (error) {
      if (attempt < maxRetries) {
        // no pane drawn yet, retry
        await delay(2000);
        continue;
      }
      // The page never drew a pane at all. Carrying on from here used to
      // hand the caller a page with nothing on it, which then failed much
      // later on a wait that only said "no prompt".
      throw new Error(
        `navigateToSession: no pane on the page for '${sessionName}' after ` +
          `${maxRetries} attempts (${error.message.split('\n')[0]})\n` +
          (await tmuxSideOfSession(page, sessionName)),
      );
    }

    // A shell prompt, when the session has a terminal to show one; a session
    // whose panes all show widgets is drawn once they are.
    try {
      await page.waitForFunction(
        () => {
          const logs = document.querySelectorAll('[role="log"]');
          if (logs.length === 0) {
            return [...document.querySelectorAll('.pane-layout-item[data-pane-id]')].every(
              (pane) => pane.querySelector('[class*="widget"]') !== null,
            );
          }
          const content = Array.from(logs)
            .map((l) => l.textContent || '')
            .join('\n');
          return content.length > 5 && /[$#%>❯]/.test(content);
        },
        { timeout: 5000, polling: 50 },
      );
      await delay(DELAYS.SHORT);
      return url;
    } catch {
      if (attempt < maxRetries) {
        // Terminal content not ready, retrying
        await delay(500);
      }
    }
  }

  // All retries exhausted with no rendered prompt: fail here, where the
  // cause is clear, instead of returning the URL and letting the caller die
  // later on an unrelated-looking assertion.
  throw new Error(
    `navigateToSession: terminal content never rendered for '${sessionName}' after ` +
      `${maxRetries} attempts\nthe page shows: ${JSON.stringify(await terminalText(page))}\n` +
      (await tmuxSideOfSession(page, sessionName)),
  );
}

/**
 * Verified round-trip readiness gate.
 * Sends a unique marker through the full pipeline (CLI → tmux → SSE → DOM)
 * and waits for it to appear. This ensures the entire data path is working
 * before the test proceeds.
 */
async function verifyRoundTrip(page, sessionName, timeout = 30000) {
  // The SSE pipeline is delivering tmux pane content to the DOM: a shell
  // prompt is visible and the XState machine is connected. Not ready yet is
  // "keep waiting" up to the budget; past it, the setup fails here, saying
  // what it saw, rather than letting the test die later on a bare "no prompt".
  try {
    await page.waitForFunction(
      () => {
        const logs = document.querySelectorAll('[role="log"]');
        const content = Array.from(logs)
          .map((l) => l.textContent || '')
          .join('\n');
        const hasPrompt = content.length > 5 && /[$#%>❯]/.test(content);
        const snap = window.app?.getSnapshot?.();
        const connected = snap?.context?.connected;
        return hasPrompt && connected;
      },
      { timeout: waitBudget(timeout), polling: 200 },
    );
  } catch {
    const connected = await page
      .evaluate(() => window.app?.getSnapshot?.()?.context?.connected ?? null)
      .catch(() => null);
    throw new Error(
      `verifyRoundTrip: no prompt from a connected client for '${sessionName}' ` +
        `(connected: ${connected})\nthe page shows: ${JSON.stringify(await terminalText(page))}\n` +
        (await tmuxSideOfSession(page, sessionName)),
    );
  }
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
 * Focus the page for keyboard input
 */
async function focusPage(page) {
  // Use locator instead of element handle to avoid DOM detachment on re-render
  try {
    await page.locator('[role="log"]').first().click({ timeout: 5000 });
  } catch {
    await page.click('body', { timeout: 5000 });
  }
  await waitForKeyboardFocus(page);
}

/**
 * Resolve once the app is really holding the keyboard.
 *
 * The app keeps a hidden 1px `<input>` focused on every device
 * (utils/mobileKeyboard.ts) and routes what lands in it to a pane, so that
 * input BEING the active element is the signal that a keystroke will arrive.
 * Anything looser — "the clicked terminal is the active element" — is true
 * the instant the click lands, before the app has taken focus, and the first
 * characters of a long command are then typed into nothing.
 *
 * Falls through after `timeout`: a few surfaces (the tree widget) never hand
 * the input focus at all, and keys sent there go where the surface sends them.
 */
async function waitForKeyboardFocus(page, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    });
    if (ready) return;
    await delay(40);
  }
}

/**
 * Wait for the SSE connection to be established and session to be ready
 * This ensures keyboard events will be sent to the correct session.
 *
 * Uses exponential backoff for the control mode connection check to handle
 * cold-start latency gracefully.
 */
async function waitForSessionReady(page, sessionName, timeout = 5000) {
  // Phase 1: Wait for terminal content (shell prompt visible)
  try {
    await page.waitForFunction(
      () => {
        const logs = document.querySelectorAll('[role="log"]');
        const content = Array.from(logs)
          .map((l) => l.textContent || '')
          .join('');
        return content.length > 5 && /[$#%>❯]/.test(content);
      },
      { timeout, polling: 50 },
    );
  } catch {
    // Shell prompt not detected within timeout
  }

  // Phase 2: Wait for window.app to be available (XState machine loaded)
  try {
    await page.waitForFunction(() => !!window.app?.getSnapshot, { timeout: 5000, polling: 100 });
  } catch {
    throw new Error(`window.app not available after 5s for session '${sessionName}'`);
  }

  // Phase 3: Wait for tmux session to exist and be responsive via CLI.
  // The server creates the session when the browser navigates to the URL,
  // but it may take a moment for control mode to attach.
  const monitorTimeout = 30000;
  const monitorStart = Date.now();
  let backoff = 200;
  const maxBackoff = 2000;

  while (Date.now() - monitorStart < monitorTimeout) {
    try {
      tmuxExec(`display-message -t ${sessionName} ""`);
      break;
    } catch {
      // Session not ready yet
    }
    await delay(backoff);
    backoff = Math.min(backoff * 1.5, maxBackoff);
  }

  // The keyboard actor routes a key to the session and pane the app holds, so
  // the session is ready for keystrokes once the app names it and has a pane
  // to aim at — not a fixed beat after tmux answered.
  await waitForCondition(
    page,
    () =>
      page.evaluate((name) => {
        const c = window.app?.getSnapshot()?.context;
        return !!c && c.sessionName === name && c.panes.length > 0 && !!c.activePaneId;
      }, sessionName),
    5000,
    `the app to hold session '${sessionName}' and an active pane`,
  );
}

/**
 * Wait for UI to show expected window count
 * @param {Page} page - Playwright page
 * @param {number} expectedCount - Expected window count
 * @param {number} timeout - Max wait time in ms
 */
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
      const snap = window.app?.getSnapshot();
      const windows = snap?.context?.windows?.map(
        (w) =>
          `${w.id}:${w.index}:${w.name}:a=${w.active}:pg=${w.windowType === 'group'}:fl=${w.windowType === 'float'}`,
      );
      return { count: tabs.length, tabInfo, windows };
    });
    throw new Error(
      `Expected ${expectedCount} window tabs, found ${diag.count} (timeout ${budget}ms)\n  DOM tabs: ${JSON.stringify(diag.tabInfo)}\n  XState windows: ${JSON.stringify(diag.windows)}`,
    );
  }
}

/**
 * Wait for UI to show expected pane count
 * @param {Page} page - Playwright page
 * @param {number} expectedCount - Expected pane count
 * @param {number} timeout - Max wait time in ms
 */
async function waitForPaneCount(page, expectedCount, timeout = 3000) {
  const budget = waitBudget(timeout);
  try {
    await page.waitForFunction(
      (count) => {
        // Count UNIQUE pane ids (matching getUIPaneCount): each pane emits
        // data-pane-id on both its layout wrapper and its inner TerminalPane,
        // and sidebar tree rows repeat the same ids — raw element counts are
        // 2x+ the real pane count. The old OR with [role="log"] could
        // satisfy the wait while the real pane elements disagreed.
        const ids = new Set();
        for (const el of document.querySelectorAll('[data-pane-id]')) {
          ids.add(el.getAttribute('data-pane-id'));
        }
        return ids.size === count;
      },
      expectedCount,
      { timeout: budget, polling: 50 },
    );
    return true;
  } catch {
    // Timeout — non-throwing, callers check the return value
    return false;
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
 * @param {Page} page - Playwright page (for context; not always used by fn)
 * @param {Function} fn - Async function returning a boolean or the value waited for
 * @param {number} timeout - Max wait in ms
 * @param {string|Function} description - Description for error message
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
 * Wait until the app has nothing outstanding, then two painted frames.
 *
 * `window.app.settled()` is the app's own answer (AppProvider): no command
 * queued or in flight to the backend, no keystroke batched and unsent, no
 * optimistic op awaiting tmux's verdict — the idle re-reconcile that drops a
 * mispredicted one included — and the store holding the state at the
 * stream's last sequence number. It is the question `delay(DELAYS.SYNC)` was
 * guessing at: this returns the moment the round trip is over rather than
 * 1500 ms after it began, and a round trip that takes longer than that on a
 * loaded runner is waited for instead of assumed done.
 *
 * It says nothing about a PROGRAM in a pane, whose output arrives whenever it
 * does; that is `waitForTerminalText`'s question.
 */
async function waitForSettled(page, timeout = 10000) {
  await waitForCondition(
    page,
    () => page.evaluate(() => window.app?.settled?.() === true),
    timeout,
    'the app to settle (a command in flight, a pending op or an unapplied state kept it busy)',
  );
  await afterFrames(page, 2);
}

module.exports = {
  waitForSettled,
  afterFrames,
  disconnectBrowser,
  delay,
  getBrowser,
  waitForServer,
  navigateToSession,
  verifyRoundTrip,
  focusPage,
  waitForKeyboardFocus,
  waitForSessionReady,
  waitForWindowCount,
  waitForPaneCount,
  waitForCondition,
};
