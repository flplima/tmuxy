/**
 * Snapshot Test — UI ↔ tmux State Verification
 *
 * Captures the visible state from both the tmuxy web UI (browser XState context)
 * and tmux CLI, then compares them to find mismatches. Read-only — no interactions,
 * no mutations.
 *
 * Structural comparison (windows, panes, content, groups, floats), then the
 * visual invariants: layout geometry, the tab strip, and the active-pane marker.
 */

const { getBrowser, waitForServer, delay } = require('../helpers/browser');
const { TMUXY_URL, DELAYS } = require('../helpers/config');
const {
  extractUIState,
  extractTmuxState,
  compareSnapshots,
} = require('../helpers/snapshot-compare');
const { assertLayoutInvariants } = require('../helpers/layout');

let browser, page;
// Track whether we own the page (created it) vs borrowed an existing one
let ownedPage = false;

beforeAll(async () => {
  await waitForServer();
  browser = await getBrowser();

  // Try to find an existing tmuxy page to avoid disrupting the user's session.
  // Opening a new page triggers get_initial_state → set_client_size which resizes
  // the tmux window and interferes with the active session.
  const existingPage = findExistingTmuxyPage(browser);
  if (existingPage) {
    page = existingPage;
    ownedPage = false;
    // Reload before comparing. A reused page is usually one an earlier suite
    // left open, and that suite's session has since been killed — the page then
    // still reports the panes it saw at the time, so every structural check
    // fails against ids tmux no longer has. Reloading rebuilds the state from
    // the server's current view while still not opening an extra tab.
    // A page this suite did not open has no init script: acknowledge the
    // first-run notice on it before the reload brings it up.
    await page
      .evaluate(() => window.localStorage.setItem('tmuxy-risk-notice-ack', '1'))
      .catch(() => {});
    await page.goto(TMUXY_URL, { waitUntil: 'load' });
  } else {
    // No existing page — open a new one (CI environment)
    page = await browser.newPage();
    // Log browser console for CI debugging
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warn' || msg.text().includes('[HttpAdapter]')) {
        console.warn(`[browser:${type}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => console.warn(`[browser:pageerror] ${err.message}`));
    await page.goto(TMUXY_URL);
    ownedPage = true;
  }

  // Wait for XState to be ready with panes and non-empty content.
  // In CI, the first SSE connection can silently die (server detects client
  // disconnect before content arrives). If that happens, reload the page to
  // establish a fresh SSE connection and retry.
  // A reused page gets the same retry budget: it was just reloaded, so its SSE
  // connection is as new as an owned page's and can die the same way.
  const maxPageAttempts = 3;
  for (let pageAttempt = 0; pageAttempt < maxPageAttempts; pageAttempt++) {
    try {
      await page.waitForFunction(
        () => {
          const ctx = window.app?.getSnapshot()?.context;
          if (!ctx?.connected || !ctx?.panes?.length) return false;
          const visiblePanes = (ctx.panes || []).filter((p) => p.windowId === ctx.activeWindowId);
          return visiblePanes.every((p) => {
            if (!p.content || !Array.isArray(p.content)) return false;
            const text = p.content
              .map((line) =>
                Array.isArray(line) ? line.map((cell) => cell?.c || '').join('') : '',
              )
              .join('');
            return text.trim().length > 0;
          });
        },
        undefined,
        { timeout: 20000 },
      );
      break; // Content arrived — proceed
    } catch (e) {
      if (pageAttempt < maxPageAttempts - 1) {
        console.warn(
          `[snapshot:beforeAll] Attempt ${pageAttempt + 1}: content empty, reloading page`,
        );
        await page.reload({ waitUntil: 'load' });
        continue;
      }
      // Final attempt failed — dump state and throw
      const state = await page
        .evaluate(() => {
          const ctx = window.app?.getSnapshot()?.context;
          const pane = ctx?.panes?.[0];
          const contentSample = pane?.content?.slice(0, 3)?.map((line) => {
            if (!line || !Array.isArray(line)) return String(line);
            return line
              .slice(0, 20)
              .map((cell) => cell?.c || '')
              .join('');
          });
          return {
            hasApp: !!window.app,
            connected: ctx?.connected,
            error: ctx?.error,
            paneCount: ctx?.panes?.length,
            sessionName: ctx?.sessionName,
            activeWindowId: ctx?.activeWindowId,
            pane0windowId: pane?.windowId,
            pane0contentLength: pane?.content?.length,
            pane0contentSample: contentSample,
          };
        })
        .catch(() => 'evaluate failed');
      console.error(
        '[snapshot:beforeAll] waitForFunction failed. Browser state:',
        JSON.stringify(state),
      );
      throw e;
    }
  }

  // Let state settle (longer for new pages in CI to ensure content arrives).
  // Also verify the shell prompt is visible in the DOM — a prompt character
  // confirms the full content pipeline (capture → vt100 → SSE → XState → React).
  await delay(ownedPage ? DELAYS.SYNC * 2 : DELAYS.SYNC);
  if (ownedPage) {
    try {
      await page.waitForFunction(
        () => {
          const logs = document.querySelectorAll('[role="log"]');
          const content = Array.from(logs)
            .map((l) => l.textContent || '')
            .join('\n');
          return content.includes('❯') || content.includes('$') || content.includes('#');
        },
        undefined,
        { timeout: 15000, polling: 200 },
      );
    } catch {
      // If prompt never appears, proceed anyway — the test will fail with a useful diff
    }
    await delay(DELAYS.SYNC);
  }
});

afterAll(async () => {
  // Only close the page if we created it (don't close the user's tab)
  if (ownedPage && page?._context) {
    await page._context.close();
    // Wait for the server's 2s grace period to complete so the monitor
    // and CC connection for this session are fully cleaned up before
    // the next jest run (E2E tests) starts.
    await delay(3000);
  }
});

/**
 * Find an existing tmuxy page in the browser's open contexts.
 * Returns the first page whose URL matches the tmuxy server, or null.
 */
function findExistingTmuxyPage(browser) {
  const contexts = browser._browser?.contexts?.() || [];
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      try {
        const url = p.url();
        if (url.includes(`localhost:${require('../helpers/config').TMUXY_PORT}`)) {
          return p;
        }
      } catch {
        // Page may be closing
      }
    }
  }
  return null;
}

// ==================== Structural Checks ====================

test('structural snapshot: UI matches tmux state', async () => {
  const sessionName = await page.evaluate(() => window.app?.getSnapshot()?.context?.sessionName);
  expect(sessionName).toBeTruthy();

  // Wait for the two to AGREE rather than sampling once after a fixed delay.
  //
  // The client asks tmux for the grid it measured and redraws when tmux says it
  // resized, so for a moment after load the UI and tmux legitimately disagree —
  // `UI=200x49, tmux=139x26` is the control-mode PTY's size on one side and the
  // client's on the other, mid-handshake. A fixed settle delay makes that a
  // race the runner's speed decides; the thing being asserted is that they
  // converge, so that is what is waited for. A real mismatch still fails, just
  // after the deadline instead of before the handshake finishes.
  let uiState = null;
  let tmuxState = null;
  let result = null;
  const deadline = Date.now() + 20000;
  do {
    [uiState, tmuxState] = await Promise.all([
      extractUIState(page),
      Promise.resolve(extractTmuxState(sessionName)),
    ]);
    result = uiState && tmuxState ? compareSnapshots(uiState, tmuxState) : null;
    if (result?.pass) break;
    await delay(250);
  } while (Date.now() < deadline);

  expect(uiState).not.toBeNull();
  expect(tmuxState).not.toBeNull();
  expect(result).not.toBeNull();

  // Report all checks
  for (const check of result.checks) {
    if (!check.pass) {
      console.warn(`  FAIL: ${check.name}${check.details ? ` — ${check.details}` : ''}`);
    }
  }

  const passed = result.checks.filter((c) => c.pass).length;
  const total = result.checks.length;
  console.warn(`  Snapshot: ${passed}/${total} checks passed`);

  expect(result.pass).toBe(true);
});

// ==================== Visual/DOM Checks ====================

test('layout invariants: no overlap, centering, padding, gaps', async () => {
  // assertLayoutInvariants throws on failure with detailed messages
  await assertLayoutInvariants(page, { label: 'snapshot' });
});

test('tab bar matches visible windows', async () => {
  const result = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const { windows } = snap.context;

    // Visible (non-group, non-float) windows from XState
    const visibleWindows = (windows || [])
      .filter((w) => w.windowType === 'tab')
      .map((w) => ({ index: w.index, name: w.name, active: w.active }))
      .sort((a, b) => a.index - b.index);

    // DOM tab elements — tabs are .tab-name buttons inside .tab-list; the
    // title lives in .tab-name-label (a ✕ close control follows it once there
    // are several tabs).
    const tabEls = Array.from(document.querySelectorAll('.tab-list .tab-name'));
    const domTabs = tabEls.map((el) => ({
      name: el.querySelector('.tab-name-label')?.textContent || el.textContent || '',
      active: el.classList.contains('tab-name-active'),
    }));

    return { visibleWindows, domTabs };
  });

  expect(result).not.toBeNull();
  expect(result.domTabs.length).toBe(result.visibleWindows.length);

  // Every tab — a lone one included — carries the active marker exactly when
  // tmux says it is active (WindowTabs.tsx keeps the active style on a sole
  // tab so the strip reads the same however many tabs there are).
  for (let i = 0; i < result.visibleWindows.length; i++) {
    const win = result.visibleWindows[i];
    // DOM tabs show "visualIndex:name" where visualIndex = position + 1
    const visualIndex = i + 1;
    const expectedTabName = `${visualIndex}:${win.name}`;
    expect(result.domTabs[i].name).toBe(expectedTabName);
    expect(result.domTabs[i].active).toBe(win.active);
  }

  // ...and exactly one of them is marked — a strip with two highlights (or
  // none) means the active flag and the class have drifted.
  expect(result.domTabs.filter((t) => t.active).length).toBe(1);
});

// ==================== Active Pane Check ====================

test('active pane has visual indicator in DOM', async () => {
  const result = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const { activePaneId, focusedFloatPaneId } = snap.context;

    // When a float is focused, tiled panes are all inactive — skip
    if (focusedFloatPaneId) return { skip: true };

    const activeEls = Array.from(document.querySelectorAll('.pane-layout-item.pane-active'));
    const activeIds = activeEls.map((el) => el.getAttribute('data-pane-id'));

    return {
      skip: false,
      activePaneId,
      domActiveIds: activeIds,
    };
  });

  expect(result).not.toBeNull();
  if (result.skip) return;

  expect(result.domActiveIds.length).toBe(1);
  expect(result.domActiveIds[0]).toBe(result.activePaneId);
});
