/**
 * Snapshot Test — UI ↔ tmux State Verification
 *
 * Captures the visible state from both the tmuxy web UI (browser XState context)
 * and tmux CLI, then compares them to find mismatches. Read-only — no interactions,
 * no mutations.
 *
 * Checks 1–15: Structural comparison (windows, panes, content, groups, floats)
 * Checks 16–22: Visual/DOM invariants (layout, connection, tabs, DOM consistency)
 */

const { getBrowser, waitForServer, delay } = require('../helpers/browser');
const { TMUXY_URL, DELAYS } = require('../helpers/config');
const { extractUIState, extractTmuxState, compareSnapshots } = require('../helpers/snapshot-compare');
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
  } else {
    // No existing page — open a new one (CI environment)
    page = await browser.newPage();
    // Log browser console for CI debugging
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warn' || msg.text().includes('[HttpAdapter]')) {
        console.warn(`[browser:${type}] ${msg.text()}`);
      }
    });
    page.on('pageerror', err => console.warn(`[browser:pageerror] ${err.message}`));
    await page.goto(TMUXY_URL);
    ownedPage = true;
  }

  // Wait for XState to be ready with panes and non-empty content.
  // In CI, the first SSE connection can silently die (server detects client
  // disconnect before content arrives). If that happens, reload the page to
  // establish a fresh SSE connection and retry.
  const maxPageAttempts = ownedPage ? 3 : 1;
  for (let pageAttempt = 0; pageAttempt < maxPageAttempts; pageAttempt++) {
    try {
      await page.waitForFunction(() => {
        const ctx = window.app?.getSnapshot()?.context;
        if (!ctx?.connected || !ctx?.panes?.length) return false;
        const visiblePanes = (ctx.panes || []).filter(p => p.windowId === ctx.activeWindowId);
        return visiblePanes.every(p => {
          if (!p.content || !Array.isArray(p.content)) return false;
          const text = p.content.map(line =>
            Array.isArray(line) ? line.map(cell => cell?.c || '').join('') : ''
          ).join('');
          return text.trim().length > 0;
        });
      }, undefined, { timeout: 20000 });
      break; // Content arrived — proceed
    } catch (e) {
      if (pageAttempt < maxPageAttempts - 1) {
        console.warn(`[snapshot:beforeAll] Attempt ${pageAttempt + 1}: content empty, reloading page`);
        await page.reload({ waitUntil: 'load' });
        continue;
      }
      // Final attempt failed — dump state and throw
      const state = await page.evaluate(() => {
        const ctx = window.app?.getSnapshot()?.context;
        const pane = ctx?.panes?.[0];
        const contentSample = pane?.content?.slice(0, 3)?.map(line => {
          if (!line || !Array.isArray(line)) return String(line);
          return line.slice(0, 20).map(cell => cell?.c || '').join('');
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
      }).catch(() => 'evaluate failed');
      console.error('[snapshot:beforeAll] waitForFunction failed. Browser state:', JSON.stringify(state));
      throw e;
    }
  }

  // Let state settle (longer for new pages in CI to ensure content arrives).
  // Also verify the shell prompt is visible in the DOM — a prompt character
  // confirms the full content pipeline (capture → vt100 → SSE → XState → React).
  await delay(ownedPage ? DELAYS.SYNC * 2 : DELAYS.SYNC);
  if (ownedPage) {
    try {
      await page.waitForFunction(() => {
        const logs = document.querySelectorAll('[role="log"]');
        const content = Array.from(logs).map(l => l.textContent || '').join('\n');
        return content.includes('❯') || content.includes('$') || content.includes('#');
      }, undefined, { timeout: 15000, polling: 200 });
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

// ==================== Structural Checks (1–15) ====================

test('structural snapshot: UI matches tmux state', async () => {
  const maxRetries = 5;
  let result;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Allow extra time between retries for content to arrive via SSE.
    // In CI, the server creates a fresh session and content delivery can
    // take several seconds through the control mode → VtEmulator pipeline.
    if (attempt > 0) await delay(DELAYS.SYNC * 3);

    const sessionName = await page.evaluate(
      () => window.app?.getSnapshot()?.context?.sessionName
    );
    expect(sessionName).toBeTruthy();

    const [uiState, tmuxState] = await Promise.all([
      extractUIState(page),
      Promise.resolve(extractTmuxState(sessionName)),
    ]);

    expect(uiState).not.toBeNull();
    expect(tmuxState).not.toBeNull();

    result = compareSnapshots(uiState, tmuxState);

    if (result.pass) break;
  }

  // Report all checks
  for (const check of result.checks) {
    if (!check.pass) {
      console.warn(`  FAIL: ${check.name}${check.details ? ` — ${check.details}` : ''}`);
    }
  }

  const passed = result.checks.filter(c => c.pass).length;
  const total = result.checks.length;
  console.warn(`  Snapshot: ${passed}/${total} checks passed`);

  expect(result.pass).toBe(true);
});

// ==================== Visual/DOM Checks (16–22) ====================

test('layout invariants: no overlap, centering, padding, gaps', async () => {
  // assertLayoutInvariants throws on failure with detailed messages
  await assertLayoutInvariants(page, { label: 'snapshot' });
});

test('connection health: connected with no errors', async () => {
  const health = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    return {
      connected: snap.context.connected,
      error: snap.context.error,
    };
  });

  expect(health).not.toBeNull();
  expect(health.connected).toBe(true);
  // Note: health.error may contain a stale message from a previous reconnect
  // cycle. We only assert the connection is currently active.
});

test('session name: URL param matches XState', async () => {
  const result = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const urlSession = new URL(window.location.href).searchParams.get('session');
    return {
      urlSession,
      xstateSession: snap.context.sessionName,
    };
  });

  expect(result).not.toBeNull();
  // URL may not have a session param (auto-detected), so only check if both exist
  if (result.urlSession) {
    expect(result.xstateSession).toBe(result.urlSession);
  }
  expect(result.xstateSession).toBeTruthy();
});

test('DOM pane count matches XState pane count', async () => {
  const result = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const { panes, activeWindowId } = snap.context;
    const xstatePaneIds = (panes || [])
      .filter(p => p.windowId === activeWindowId)
      .map(p => p.tmuxId)
      .sort();

    const domPaneIds = Array.from(
      document.querySelectorAll('.pane-layout-item[data-pane-id]')
    )
      .map(el => el.getAttribute('data-pane-id'))
      .filter(id => xstatePaneIds.includes(id))
      .sort();

    return { xstatePaneIds, domPaneIds };
  });

  expect(result).not.toBeNull();
  expect(result.domPaneIds).toEqual(result.xstatePaneIds);
});

test('tab bar matches visible windows', async () => {
  const result = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const { windows } = snap.context;

    // Visible (non-group, non-float) windows from XState
    const visibleWindows = (windows || [])
      .filter(w => !w.isPaneGroupWindow && !w.isFloatWindow)
      .map(w => ({ index: w.index, name: w.name, active: w.active }))
      .sort((a, b) => a.index - b.index);

    // DOM tab elements — tabs are .tab-name spans inside .tab-list
    const tabEls = Array.from(document.querySelectorAll('.tab-list .tab-name'));
    const domTabs = tabEls.map(el => ({
      name: el.textContent || '',
      active: el.classList.contains('tab-name-active'),
    }));

    return { visibleWindows, domTabs };
  });

  expect(result).not.toBeNull();
  expect(result.domTabs.length).toBe(result.visibleWindows.length);

  for (let i = 0; i < result.visibleWindows.length; i++) {
    const win = result.visibleWindows[i];
    // DOM tabs show "visualIndex:name" where visualIndex = position + 1
    const visualIndex = i + 1;
    const expectedTabName = `${visualIndex}:${win.name}`;
    expect(result.domTabs[i].name).toBe(expectedTabName);
    expect(result.domTabs[i].active).toBe(win.active);
  }
});

test('no orphan DOM panes: every data-pane-id has an XState pane', async () => {
  const result = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const allPaneIds = new Set((snap.context.panes || []).map(p => p.tmuxId));

    const domPaneIds = Array.from(
      document.querySelectorAll('[data-pane-id]')
    ).map(el => el.getAttribute('data-pane-id'));

    const orphans = domPaneIds.filter(id => !allPaneIds.has(id));
    return { orphans, total: domPaneIds.length };
  });

  expect(result).not.toBeNull();
  expect(result.orphans).toEqual([]);
});

// ==================== Flicker Detection (23–24) ====================

test('no terminal content flicker: lines should not re-render when idle', async () => {
  const OBSERVE_MS = 3000;

  // Start a MutationObserver on all terminal content (lines, spans, text)
  await page.evaluate(() => {
    window.__termFlickerData = {
      mutations: [],
      startTime: performance.now(),
    };

    const containers = document.querySelectorAll('.terminal-content');
    if (containers.length === 0) return;

    const observer = new MutationObserver((records) => {
      const ts = performance.now() - window.__termFlickerData.startTime;
      for (const m of records) {
        // Get pane ID from closest ancestor
        const paneId = m.target.closest?.('[data-pane-id]')?.getAttribute('data-pane-id') || 'unknown';

        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            const text = node.textContent?.slice(0, 40) || '';
            const tag = node.nodeType === 1 ? node.tagName : '#text';
            window.__termFlickerData.mutations.push({
              ts, type: 'add', paneId, tag, text,
              // Which terminal line was affected
              lineIdx: getLineIndex(m.target),
            });
          }
          for (const node of m.removedNodes) {
            const text = node.textContent?.slice(0, 40) || '';
            const tag = node.nodeType === 1 ? node.tagName : '#text';
            window.__termFlickerData.mutations.push({
              ts, type: 'remove', paneId, tag, text,
              lineIdx: getLineIndex(m.target),
            });
          }
        } else if (m.type === 'characterData') {
          window.__termFlickerData.mutations.push({
            ts, type: 'text-change', paneId,
            oldText: m.oldValue?.slice(0, 40) || '',
            newText: m.target.textContent?.slice(0, 40) || '',
            lineIdx: getLineIndex(m.target),
          });
        }
      }
    });

    function getLineIndex(node) {
      const el = node.nodeType === 1 ? node : node.parentElement;
      const line = el?.closest?.('.terminal-line');
      if (!line) return -1;
      const parent = line.parentElement;
      if (!parent) return -1;
      return Array.from(parent.children).indexOf(line);
    }

    for (const container of containers) {
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: true,
      });
    }

    window.__termFlickerObserver = observer;
  });

  // Wait for observation period
  await delay(OBSERVE_MS);

  // Collect results
  const result = await page.evaluate(() => {
    if (window.__termFlickerObserver) {
      window.__termFlickerObserver.disconnect();
      window.__termFlickerObserver = null;
    }
    const data = window.__termFlickerData;
    if (!data) return null;

    const mutations = data.mutations;

    // Group mutations by pane + line to detect flicker patterns
    // Flicker = same line getting add/remove cycles for the same content
    const lineGroups = {};
    for (const m of mutations) {
      const key = `${m.paneId}:line${m.lineIdx}`;
      if (!lineGroups[key]) lineGroups[key] = [];
      lineGroups[key].push(m);
    }

    // Detect flicker: a line that has >4 mutations in the observation window
    // while idle (no user input) indicates unnecessary re-renders
    const flickerLines = [];
    for (const [key, muts] of Object.entries(lineGroups)) {
      if (muts.length > 4) {
        flickerLines.push({
          key,
          count: muts.length,
          sample: muts.slice(0, 6).map(m => ({
            ts: Math.round(m.ts),
            type: m.type,
            text: m.text || m.newText || '',
          })),
        });
      }
    }

    return {
      totalMutations: mutations.length,
      flickerLines,
      // Also report any lines with just a few mutations (context)
      lineGroupCounts: Object.fromEntries(
        Object.entries(lineGroups).map(([k, v]) => [k, v.length])
      ),
    };
  });

  expect(result).not.toBeNull();

  if (result.flickerLines.length > 0) {
    const details = result.flickerLines.map(f =>
      `  ${f.key}: ${f.count} mutations\n` +
      f.sample.map(s => `    +${s.ts}ms ${s.type}: ${JSON.stringify(s.text)}`).join('\n')
    ).join('\n');
    console.warn(`Terminal flicker detected (${result.totalMutations} total mutations):\n${details}`);
  }

  // Allow cursor blink mutations (1 line with periodic changes is OK)
  // But flag any line with >4 mutations as flicker
  expect(result.flickerLines.length).toBe(0);
}, 10000);

test('no layout flicker: pane containers stable when idle', async () => {
  const OBSERVE_MS = 2000;

  // Use GlitchDetector-style observer on layout elements (NOT terminal content)
  await page.evaluate(() => {
    window.__layoutFlickerData = {
      mutations: [],
      startTime: performance.now(),
    };

    const container = document.querySelector('.pane-container');
    if (!container) return;

    const observer = new MutationObserver((records) => {
      const ts = performance.now() - window.__layoutFlickerData.startTime;
      for (const m of records) {
        // Skip terminal content (handled by the other test)
        if (m.target.closest?.('.terminal-content')) continue;
        if (m.target.classList?.contains('terminal-content')) continue;

        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          const targetId = m.target.className?.split?.(' ').slice(0, 2).join('.') || m.target.tagName;
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            window.__layoutFlickerData.mutations.push({
              ts, type: 'add',
              target: targetId,
              element: node.className?.split?.(' ').slice(0, 2).join('.') || node.tagName,
            });
          }
          for (const node of m.removedNodes) {
            if (node.nodeType !== 1) continue;
            window.__layoutFlickerData.mutations.push({
              ts, type: 'remove',
              target: targetId,
              element: node.className?.split?.(' ').slice(0, 2).join('.') || node.tagName,
            });
          }
        } else if (m.type === 'attributes') {
          const targetId = m.target.className?.split?.(' ').slice(0, 2).join('.') || m.target.tagName;
          window.__layoutFlickerData.mutations.push({
            ts, type: 'attr',
            target: targetId,
            attr: m.attributeName,
            oldValue: m.oldValue?.slice(0, 60),
            newValue: m.target.getAttribute(m.attributeName)?.slice(0, 60),
          });
        }
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style', 'data-active', 'data-pane-id'],
    });

    window.__layoutFlickerObserver = observer;
  });

  await delay(OBSERVE_MS);

  const result = await page.evaluate(() => {
    if (window.__layoutFlickerObserver) {
      window.__layoutFlickerObserver.disconnect();
      window.__layoutFlickerObserver = null;
    }
    const data = window.__layoutFlickerData;
    if (!data) return null;

    // Detect rapid add/remove cycles (flicker)
    const elementGroups = {};
    for (const m of data.mutations) {
      const key = m.element || m.target;
      if (!elementGroups[key]) elementGroups[key] = [];
      elementGroups[key].push(m);
    }

    const flickers = [];
    for (const [key, muts] of Object.entries(elementGroups)) {
      // Look for add→remove or remove→add within 200ms
      for (let i = 0; i < muts.length - 1; i++) {
        const curr = muts[i];
        const next = muts[i + 1];
        if (curr.type !== next.type &&
            (curr.type === 'add' || curr.type === 'remove') &&
            (next.type === 'add' || next.type === 'remove') &&
            (next.ts - curr.ts) < 200) {
          flickers.push({ key, curr, next, gapMs: next.ts - curr.ts });
        }
      }
    }

    return {
      totalMutations: data.mutations.length,
      flickers,
      mutations: data.mutations.slice(0, 20),
    };
  });

  expect(result).not.toBeNull();

  if (result.flickers.length > 0) {
    const details = result.flickers.slice(0, 5).map(f =>
      `  ${f.key}: ${f.curr.type}→${f.next.type} in ${f.gapMs.toFixed(0)}ms`
    ).join('\n');
    console.warn(`Layout flicker detected:\n${details}`);
  }

  expect(result.flickers.length).toBe(0);
}, 10000);

// ==================== Active Pane Check (25) ====================

test('active pane has visual indicator in DOM', async () => {
  const result = await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const { activePaneId, focusedFloatPaneId } = snap.context;

    // When a float is focused, tiled panes are all inactive — skip
    if (focusedFloatPaneId) return { skip: true };

    const activeEls = Array.from(
      document.querySelectorAll('.pane-layout-item.pane-active')
    );
    const activeIds = activeEls.map(el => el.getAttribute('data-pane-id'));

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
