/**
 * Tauri Desktop App IPC Commands E2E Tests
 *
 * Tests the Tauri IPC integration seam (`run_tmux_command`, `query_tmux`,
 * `get_initial_state`, `get_scrollback_cells`, snackbar error reporting).
 */

const {
  createTauriTestContext,
  waitForTerminalText,
  typeKeys,
  pressKey,
  getAppState,
  invokeCommand,
  waitForPaneCount,
  waitForRawWindowCount,
} = require('./helpers/wdio-client');
const { tmuxExec } = require('../helpers/tmux-socket');

const ctx = createTauriTestContext();
let driver = null;
let sessionName = null;

afterEach(async () => {
  await ctx.afterEachHook();
  driver = null;
  sessionName = null;
});

async function setupApp(options = {}) {
  const result = await ctx.setupApp(options);
  driver = result.driver;
  sessionName = result.sessionName;
  return result;
}

// ==================== IPC Commands ====================

describe('IPC Commands', () => {
  test('typed input reaches the terminal; a split over IPC arrives as a sized pane through the delta protocol', async () => {
    await setupApp();

    const marker = `TAURI_TEST_${Date.now()}`;
    await typeKeys(driver, `echo ${marker}`);
    await pressKey(driver, 'Enter');
    await waitForTerminalText(driver, marker);

    // Baseline pane count, not an absolute: the app always attaches to the
    // `tmuxy` session, and a previous test's kill-session can race the next
    // app start — leftover panes would fail a hardcoded `toBe(1)`.
    const before = (await getAppState(driver)).panes.length;
    expect(before).toBeGreaterThanOrEqual(1);

    // Split via the same IPC path the UI uses; the new pane reaches the
    // client as a Tauri event → delta.
    await invokeCommand(driver, 'run_tmux_command', { command: 'split-window -h' });
    await waitForPaneCount(driver, before + 1);

    const state = await getAppState(driver);
    expect(state.panes.length).toBeGreaterThanOrEqual(before + 1);
    for (const pane of state.panes) {
      expect(pane.width).toBeGreaterThan(0);
      expect(pane.height).toBeGreaterThan(0);
    }
  });

  test('query_tmux returns what a command printed; run_tmux_command returns nothing', async () => {
    await setupApp();

    // A read goes through query_tmux and is answered in-band on the monitor's
    // control-mode connection — no subprocess, and the same contract as web.
    const result = await invokeCommand(driver, 'query_tmux', {
      command: 'display-message -p #{session_name}',
    });
    expect(result).toContain(sessionName);

    // A mutation is fire-and-forget on every transport: it resolves to
    // nothing, exactly as the web server answers it.
    const nothing = await invokeCommand(driver, 'run_tmux_command', {
      command: 'display-message -p #{session_name}',
    });
    expect(nothing == null || nothing === '').toBe(true);
  });

  // The bug this transport used to have: the frontend pins every command to
  // the tab the user is looking at (`select-window ; select-pane ; <cmd>`),
  // and the desktop rewrote the pinned command with a session target that
  // tmux resolves late — against whatever window the session was on when
  // the command ran. A split on tab B landed on tab A. Every command now
  // reaches tmux byte-identical over the control-mode connection.
  test("a split pinned to a tab that is not tmux's current window lands on that tab", async () => {
    await setupApp();
    await waitForRawWindowCount(driver, 1);

    // Two windows; tmux's current window is the FIRST, the pin names the second.
    // Asked of tmux itself: the client's window list counts an optimistic
    // placeholder before tmux has the window.
    await invokeCommand(driver, 'run_tmux_command', { command: 'new-window' });
    const listWindows = async () =>
      (
        await invokeCommand(driver, 'query_tmux', {
          command: "list-windows -F '#{window_id} #{pane_id}'",
        })
      )
        .trim()
        .split('\n')
        .map((line) => line.split(' '));
    let windows = await listWindows();
    for (let i = 0; i < 50 && windows.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 200));
      windows = await listWindows();
    }
    if (windows.length !== 2) {
      // What tmux has, and what it said: a rejected new-window is a snackbar
      // entry now, so the reason is on the page.
      const all = await invokeCommand(driver, 'query_tmux', {
        command:
          "list-windows -a -F '#{session_name} #{window_id} #{window_width}x#{window_height}'",
      });
      const notes = await driver.execute(() =>
        (window.app?.getSnapshot()?.context?.notifications || []).map((n) => n.text),
      );
      throw new Error(
        `expected 2 windows in the session, tmux lists: ${JSON.stringify(all)}; notifications: ${JSON.stringify(notes)}`,
      );
    }
    const [first, second] = windows;
    await invokeCommand(driver, 'run_tmux_command', { command: `select-window -t ${first[0]}` });

    const panesIn = async (windowId) =>
      (await invokeCommand(driver, 'query_tmux', { command: `list-panes -t ${windowId}` }))
        .trim()
        .split('\n')
        .filter(Boolean).length;
    expect(await panesIn(second[0])).toBe(1);

    await invokeCommand(driver, 'run_tmux_command', {
      command: `select-window -t ${second[0]} \\; select-pane -t ${second[1]} \\; split-window -h`,
    });

    // The split is on the pinned window — and NOT on the one tmux was on.
    const start = Date.now();
    while ((await panesIn(second[0])) < 2 && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await panesIn(second[0])).toBe(2);
    expect(await panesIn(first[0])).toBe(1);
  });

  // Regression for the "+ New Tab" button: the frontend dispatches
  // SEND_TMUX_COMMAND with `new-window`, which routes through
  // adapter.invoke('run_tmux_command'). On tmux 3.5a a bare external
  // `tmux new-window` while control mode is attached crashes the server,
  // so run_tmux_command must intercept and rewrite to `splitw ; breakp` —
  // exactly like the SSE server does.
  // A mutation resolves to nothing, so tmux's `%error` is the only word the
  // user gets when a command did nothing. The monitor attributes it to the
  // command and the app shows it in the snackbar.
  test('a rejected run_tmux_command is reported in the snackbar', async () => {
    await setupApp();
    const message = "can't find window: @999";
    await invokeCommand(driver, 'run_tmux_command', { command: 'kill-window -t @999' });

    const snackbarTexts = () =>
      driver.execute(() =>
        Array.from(document.querySelectorAll('[data-testid="snackbar-item"]')).map(
          (el) => el.textContent,
        ),
      );
    const start = Date.now();
    let texts = [];
    while (!texts.some((t) => t.includes(message)) && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 200));
      texts = await snackbarTexts();
    }
    expect(texts.some((t) => t.includes(message))).toBe(true);

    // Its close button takes it away.
    await driver.execute((needle) => {
      const item = Array.from(document.querySelectorAll('[data-testid="snackbar-item"]')).find(
        (el) => el.textContent.includes(needle),
      );
      item.querySelector('button[aria-label="Dismiss notification"]').click();
    }, message);
    await new Promise((r) => setTimeout(r, 300));
    expect((await snackbarTexts()).some((t) => t.includes(message))).toBe(false);
  });

  test('new-window over IPC is rewritten to splitw+breakp: tmux survives and the window appears', async () => {
    await setupApp();

    // Assert on the raw window count (ctx.windows), which the monitor reports
    // as soon as the window exists. The @tmuxy-window-type=tab classification
    // is stamped asynchronously and, under CI's tmux 3.4, can lag indefinitely,
    // so gating on it made this flaky. Window creation is classification-independent.
    await waitForRawWindowCount(driver, 1);

    await invokeCommand(driver, 'run_tmux_command', { command: 'new-window' });

    // A bare `new-window` while control mode is attached crashes tmux 3.5a;
    // if the rewrite worked, the server is still alive and answers.
    const result = await invokeCommand(driver, 'query_tmux', {
      command: 'display-message -p #{session_name}',
    });
    expect(result).toContain(sessionName);
    await waitForRawWindowCount(driver, 2);
  });

  // The monitor starts with the app, before the webview can listen, so its
  // one Full broadcast is gone by the time the frontend asks for a baseline.
  // That baseline used to be a subprocess poll that did not know the modes a
  // program had set before the app started — so a pane running a full-screen
  // mouse-tracking program (Claude Code) stayed "plain" on the client and
  // every wheel over it was dropped. The initial state is the monitor's own now.
  test('get_initial_state reports the modes of a program that was already running', async () => {
    await setupApp();
    await invokeCommand(driver, 'run_tmux_command', {
      command:
        'send-keys -l \'printf "\\033[?1049h\\033[?1000h\\033[?1006h"; sleep 60\' \\; send-keys Enter',
    });
    // tmux has the modes once the program printed them.
    let flags = '';
    for (let i = 0; i < 50; i++) {
      flags = tmuxExec(
        `display-message -p -t ${sessionName} '#{alternate_on} #{mouse_any_flag}'`,
      ).trim();
      if (flags === '1 1') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(flags).toBe('1 1');

    const state = await invokeCommand(driver, 'get_initial_state', { cols: 120, rows: 40 });
    const pane = state.panes.find((p) => p.active) || state.panes[0];
    expect(pane.alternate_on).toBe(true);
    expect(pane.mouse_any_flag).toBe(true);
  });

  // Regression for copy mode scrollback: without get_scrollback_cells the
  // frontend's FETCH_SCROLLBACK_CELLS path errors silently, leaving the
  // user staring at empty rows when scrolling up past the live viewport.
  // Pre-fix, calling this command threw "Unknown command get_scrollback_cells"
  // — the bug was the missing IPC binding, not the underlying parsing.
  test('get_scrollback_cells is exposed and returns the expected shape', async () => {
    await setupApp();

    // `panes[0].id` — `getAppState` projects each pane as `{ id, windowId, … }`,
    // so the `panes[0]?.tmuxId` this used to read was ALWAYS undefined and the
    // `?? '%0'` fallback always fired. The test then asked tmux about a pane
    // that does not exist and read the honest "tmux pane '%0' does not exist"
    // as the IPC binding being broken. No fallback now: wait for the pane, and
    // say so if it never arrives.
    let paneId;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !paneId) {
      paneId = (await getAppState(driver)).panes?.[0]?.id;
      if (!paneId) await driver.pause(200);
    }
    expect(paneId).toMatch(/^%\d+$/);
    const result = await invokeCommand(driver, 'get_scrollback_cells', {
      paneId,
      start: -200,
      end: -1,
    });

    // The frontend's FETCH_SCROLLBACK_CELLS handler asserts these fields
    // (see tmuxActor.ts). If any are missing the copy-mode chunk-merge
    // throws and the scrollback stays empty.
    expect(result).toBeDefined();
    // The error first: a failed command resolves as `{ __error }` (see
    // invokeCommand), and asserting a missing `cells` before it reported
    // "Received: undefined" while the reason sat unread in the same object.
    expect(result.__error).toBeUndefined();
    expect(result.cells).toBeDefined();
    expect(Array.isArray(result.cells)).toBe(true);
    expect(typeof result.historySize).toBe('number');
    expect(typeof result.start).toBe('number');
    expect(typeof result.end).toBe('number');
    expect(typeof result.width).toBe('number');
    // The bug-3 invocation surface (an unknown command name) returns
    // `{ __error: ... }` from invokeCommand's wrapper; assert no error.
    expect(result.__error).toBeUndefined();
  });
});
