/**
 * The desktop app's GUI windows: a new window's splash page (joining a
 * session's group, or a new session of its own), the window styles and the
 * native menu bar. The rest of the desktop's seam is tauri-app.test.js.
 *
 * Stack: Jest → WebdriverIO → tauri-driver (port 4444) → WebKitWebDriver → Tauri app.
 * Each test launches a fresh app on a fresh tmux session.
 */

const { execSync } = require('child_process');
const {
  createTauriTestContext,
  invokeCommand,
  invokeWindowCommand,
  waitForRawWindowCount,
} = require('./helpers/wdio-client');
const { tmuxCmd, tmuxExec } = require('../helpers/tmux-socket');
const { waitForCondition } = require('../helpers/browser');

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

// ==================== GUI windows over one session ====================

describe('GUI windows', () => {
  /**
   * The Window menu's own commands. A new window opens on a splash page that
   * lists this machine's sessions and takes an ssh host; picking a session
   * makes the window a second client on a second session in that session's
   * group: they share every tab and pane and each keeps its own current tab,
   * which is the whole point — one window can show one tab while the other
   * shows a different one.
   */
  test('New Window opens on a splash page; picking the session joins its group, with its own current tab', async () => {
    await setupApp();

    // A second tab to have somewhere to diverge to.
    await invokeCommand(driver, 'run_tmux_command', { command: 'new-window' });
    await waitForRawWindowCount(driver, 2);

    const before = await invokeWindowCommand(driver, 'list_gui_windows');
    expect(before).toHaveLength(1);
    expect(before[0].index).toBe(1);

    await invokeWindowCommand(driver, 'new_window');

    // The registry knows both windows, and the digit that focuses each.
    let listed = [];
    await waitForCondition(
      null,
      async () => (listed = await invokeWindowCommand(driver, 'list_gui_windows')).length === 2,
      30000,
      () => `the registry to list two windows (it lists ${JSON.stringify(listed)})`,
    );
    expect(listed.map((w) => w.index)).toEqual([1, 2]);

    // The new window is on its splash page, attached to nothing yet.
    const grouped = `${sessionName}+2`;
    expect(tmuxExec("list-sessions -F '#{session_name}'")).not.toContain(grouped);
    const mainHandle = await driver.getWindowHandle();
    let handles = [];
    for (let i = 0; i < 60 && handles.length < 2; i++) {
      handles = await driver.getWindowHandles();
      if (handles.length < 2) await new Promise((r) => setTimeout(r, 500));
    }
    expect(handles).toHaveLength(2);
    await driver.switchToWindow(handles.find((h) => h !== mainHandle));
    const row = await driver.$(
      `//button[contains(@class,"splash-session")][.//span[text()="${sessionName}"]]`,
    );
    await row.waitForDisplayed({ timeout: 20000 });
    const box = await row.getSize();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);

    // An ssh option is refused by the desktop, and the page says why.
    const host = await driver.$('//label[normalize-space()="Host"]/following-sibling::input');
    await host.setValue('-oProxyCommand=sh');
    await (await driver.$('//button[normalize-space()="Connect"]')).click();
    const alert = await driver.$('[role="alert"]');
    await alert.waitForDisplayed({ timeout: 10000 });
    expect(await alert.getText()).toContain('is not a host to connect to');

    // A click on the session attaches the window: the app replaces the page.
    await row.click();
    await (await driver.$('.pane-layout-item')).waitForDisplayed({ timeout: 30000 });
    await driver.switchToWindow(mainHandle);

    // tmux's side of it: a second session, grouped with the first, so the
    // windows are shared rather than copied.
    let sessions = '';
    await waitForCondition(
      null,
      () =>
        (sessions = tmuxExec(
          "list-sessions -F '#{session_name} #{session_group} #{session_windows}'",
        )).includes(grouped),
      30000,
      () => `the grouped session ${grouped} (tmux has: ${sessions})`,
    );
    const rows = sessions.split('\n').filter((r) => r.trim().length > 0);
    const base = rows.find((r) => r.startsWith(`${sessionName} `));
    const second = rows.find((r) => r.startsWith(`${grouped} `));
    expect(second).toBeDefined();
    // Same group, and the same number of windows — shared, not duplicated.
    expect(second.split(' ')[1]).toBe(base.split(' ')[1]);
    expect(second.split(' ')[2]).toBe(base.split(' ')[2]);
    // The Window menu names the second window by its session.
    const titles = (await invokeWindowCommand(driver, 'list_gui_windows')).map((w) => w.title);
    expect(titles[1]).toBe(`tmuxy — ${grouped}`);

    // Each client has its own current window: moving THIS window's client
    // leaves the other where it was, which is what a session group buys and what
    // two clients on one session could never do. The move goes through this
    // window's own control-mode connection — an external tmux mutation while a
    // control client is attached can crash tmux 3.5a.
    const indexes = tmuxExec(`list-windows -t ${sessionName} -F '#{window_index}'`)
      .split('\n')
      .map((i) => i.trim())
      .filter((i) => i.length > 0);
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    const currentOf = (session) =>
      tmuxExec(`display-message -p -t ${session} '#{window_index}'`).trim();
    const otherBefore = currentOf(grouped);

    const target = indexes.find((i) => i !== otherBefore);
    await invokeCommand(driver, 'run_tmux_command', {
      command: `select-window -t ${sessionName}:${target}`,
    });

    await waitForCondition(
      null,
      () => currentOf(sessionName) === target,
      15000,
      () => `this window's client on ${target} (it is on ${currentOf(sessionName)})`,
    );
    // The second window did not follow.
    expect(currentOf(grouped)).toBe(otherBefore);

    // Cleaning up after itself: the grouped session is the second window's, and
    // the suite's teardown only knows about the base one.
    execSync(`${tmuxCmd()} kill-session -t ${grouped}`, { stdio: 'ignore' });
  }, 180000);

  test("New Window's New session starts a session of its own on this machine, which outlives the window", async () => {
    await setupApp();
    const mainHandle = await driver.getWindowHandle();
    await invokeWindowCommand(driver, 'new_window');
    let handles = [];
    for (let i = 0; i < 60 && handles.length < 2; i++) {
      handles = await driver.getWindowHandles();
      if (handles.length < 2) await new Promise((r) => setTimeout(r, 500));
    }
    expect(handles).toHaveLength(2);
    await driver.switchToWindow(handles.find((h) => h !== mainHandle));

    const fresh = await driver.$('//button[contains(normalize-space(),"New session")]');
    await fresh.waitForDisplayed({ timeout: 20000 });
    await fresh.click();
    // A name of this run's own: a session left by a run that failed would
    // be refused as taken.
    const name = `${sessionName}-new-${Date.now().toString(36)}`;
    const field = await driver.$(
      '//label[normalize-space()="Name of the new session"]/following-sibling::div/input',
    );
    await field.waitForDisplayed({ timeout: 10000 });
    await field.setValue(name);
    const cleanUp = () => execSync(`${tmuxCmd()} kill-session -t ${name}`, { stdio: 'ignore' });
    try {
      await (await driver.$('//button[normalize-space()="Create"]')).click();
      await (await driver.$('.pane-layout-item')).waitForDisplayed({ timeout: 30000 });

      // A session of its own: in no group, and the window named by it.
      let sessions = '';
      await waitForCondition(
        null,
        () =>
          (sessions = tmuxExec("list-sessions -F '#{session_name}|#{session_group}'"))
            .split('\n')
            .includes(`${name}|`),
        30000,
        () => `the new session ${name}, in no group (tmux has: ${sessions})`,
      );
      const titles = (await invokeWindowCommand(driver, 'list_gui_windows')).map((w) => w.title);
      expect(titles).toContain(`tmuxy — ${name}`);

      // The user's session like any other: closing its window leaves it running.
      // The window closes under the script that asked, so no answer comes back:
      // what it did is read from the first window.
      await invokeWindowCommand(driver, 'close_window').catch(() => {});
      await driver.switchToWindow(mainHandle);
      await waitForCondition(
        null,
        async () => (await invokeWindowCommand(driver, 'list_gui_windows')).length === 1,
        30000,
        'the second window to close',
      );
      expect(tmuxExec("list-sessions -F '#{session_name}'").split('\n')).toContain(name);
    } finally {
      try {
        cleanUp();
      } catch {
        // Never made, or already gone.
      }
    }
  }, 180000);

  test('a window style is applied and reported back', async () => {
    await setupApp();

    expect(await invokeWindowCommand(driver, 'get_window_style')).toBe('normal');

    // A docked style: the window keeps its height and spans the work area, which
    // is iTerm2's "Full-Width Top of Screen".
    await invokeWindowCommand(driver, 'set_window_style', { style: 'full-width-top' });
    expect(await invokeWindowCommand(driver, 'get_window_style')).toBe('full-width-top');

    // Normal puts back the frame the window had before it was styled.
    await invokeWindowCommand(driver, 'set_window_style', { style: 'normal' });
    expect(await invokeWindowCommand(driver, 'get_window_style')).toBe('normal');

    // No Title Bar and back, also out of full screen and out of a maximized
    // frame: after each Normal the page is as tall as it was before the cycle
    // (rewriting the decorations on macOS can put a real title-bar strip above
    // the page and cost it that height; `outerHeight` is 0 in WebKit, so the
    // page's own height is the measure) and the room the status bar keeps for the traffic lights is
    // back; with no title bar the room is gone. The chrome itself is macOS's:
    // elsewhere (CI runs this suite under Xvfb) only the reported style is
    // asserted.
    const chrome = () =>
      driver.execute(() => ({
        inner: window.innerHeight,
        spacer: document.querySelector('.traffic-light-spacer')?.getBoundingClientRect().width ?? 0,
      }));
    const before = await chrome();
    const settled = async (style) => {
      // Full screen enters and leaves with an animation; the style lands after it.
      await waitForCondition(
        null,
        async () => (await invokeWindowCommand(driver, 'get_window_style')) === style,
        10000,
        `the window style ${style}`,
      );
      await driver.pause(style === 'full-screen' ? 2000 : 500);
      expect(await invokeWindowCommand(driver, 'get_window_style')).toBe(style);
    };
    for (const cycle of [
      ['no-title-bar', 'normal'],
      ['full-screen', 'no-title-bar', 'normal'],
      ['full-width-top', 'no-title-bar', 'maximized', 'normal'],
    ]) {
      for (const style of cycle) {
        await invokeWindowCommand(driver, 'set_window_style', { style });
        await settled(style);
        if (process.platform !== 'darwin') continue;
        const seen = await chrome();
        if (style === 'no-title-bar') {
          expect(seen.spacer).toBe(0);
        }
        if (style === 'normal') {
          expect(seen.inner).toBe(before.inner);
          expect(seen.spacer).toBe(before.spacer);
        }
      }
    }

    // A style nobody defines is refused rather than silently ignored.
    //
    // The refusal arrives as `{ __error }`, not as a rejected promise:
    // `invokeCommand` catches what `invoke()` throws and resolves with it, so
    // it never rejects and `.rejects` could not pass whatever the app did.
    const refused = await invokeWindowCommand(driver, 'set_window_style', { style: 'sideways' });
    expect(refused.__error).toMatch(/unknown window style/i);
    expect(refused.__kind).toBe('invalid');
  }, 120000);

  // The menus are the page's: one spec per surface, and on macOS the menu bar
  // is set from it. A WebDriver cannot click a native menu, so the suite tests
  // the seam — the bar's spec holds the app's items in their places, and the
  // platform takes the menu (macOS; Linux has no menu bar to set).
  test('the native menu bar is built from the menu spec and the platform takes it', async () => {
    await setupApp();

    let ids = [];
    await waitForCondition(
      null,
      async () => (ids = await driver.execute(() => window.tmuxyMenus?.barIds() ?? [])).length > 0,
      10000,
      'the menu bar spec',
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        'menu-app',
        'session-reload-config',
        'restart-app',
        'menu-pane',
        'pane-split-below',
        'tab-overview',
        'tab-stack-toggle',
        'window-close',
        'trace-enabled',
        'menu-theme',
      ]),
    );
    // A context menu is about its thing: nothing of the app section in the
    // pane menu, and nothing twice in the bar.
    expect(new Set(ids).size).toBe(ids.length);

    if (process.platform === 'darwin') {
      const set = await driver.executeAsync((done) => {
        window.tmuxyMenus
          .rebuild()
          .then((ok) => done(ok))
          .catch((e) => done(`error: ${e?.message ?? e}`));
      });
      expect(set).toBe(true);
    }
  }, 120000);
});
