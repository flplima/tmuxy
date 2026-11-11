/**
 * The desktop app beside the user's own tmux: the launch notice and its offer.
 *
 * The web server can only say how to start on the other socket
 * (`tests/4-session-connectivity-own-tmux.test.js`); the desktop app can go
 * there itself. This launches it the way a released app is launched, with no
 * socket named, beside a stand-in for the user's tmux (`ownTmuxWorld`), so it
 * needs a driver of its own: tauri-driver hands the app its environment, and
 * the suite's driver names the suite's socket.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, waitForXState, waitForTerminalText } = require('./helpers/wdio-client');
const { startTauriDriver, stopTauriDriver, DRIVER_PORT } = require('./helpers/tauri-driver');
const { ownTmuxWorld } = require('../helpers/own-tmux');
const { waitForCondition } = require('../helpers/browser');

const OWN_DRIVER_PORT = DRIVER_PORT + 10;

describe('The user has tmux sessions of their own', () => {
  const root = path.join(os.tmpdir(), `tmuxy-own-tmux-tauri-${process.pid}`);
  const world = ownTmuxWorld({ root });
  let driver = null;

  beforeAll(async () => {
    world.startUsersTmux(['notes', 'work']);
    await startTauriDriver(OWN_DRIVER_PORT, {
      env: { ...world.env, DISPLAY: process.env.DISPLAY || ':99' },
      nativePort: OWN_DRIVER_PORT + 1,
    });
  });

  afterAll(async () => {
    try {
      await driver?.deleteSession();
    } catch {
      // Already gone.
    }
    stopTauriDriver(OWN_DRIVER_PORT);
    await world.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The notice as the user sees it: its text and buttons, when it has a box on screen. */
  const notice = () =>
    driver.execute(() => {
      const el = document.querySelector('[data-testid="own-tmux-notice"]');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.right > window.innerWidth) return null;
      return {
        stage: el.getAttribute('data-stage'),
        text: el.textContent,
        buttons: [...el.querySelectorAll('button')].map((button) => button.textContent),
      };
    });
  const attachedSession = () =>
    driver.execute(() => window.app?.getSnapshot().context.sessionName ?? null);

  test('the launch offers the user’s tmux → taking it opens their session there → the notice says how to stay, and is answered for good', async () => {
    driver = await launchApp(undefined, OWN_DRIVER_PORT);
    await waitForXState(driver, 30000);

    // 1. The app opened on its own empty session, and says where the user's
    //    two are, with the switch it can make.
    await waitForCondition(null, async () => (await notice()) !== null, 30000, 'the launch notice');
    const asked = await notice();
    expect(asked.stage).toBe('ask');
    expect(asked.text).toContain('Your tmux has 2 sessions on its default socket');
    expect(asked.text).not.toContain('TMUX_SOCKET');
    expect(asked.buttons).toEqual(['Use my tmux', 'Stay here']);
    expect(await attachedSession()).toBe('tmuxy');
    expect(world.usersAttachedSessions()).toEqual([]);
    const sessionsBefore = world.usersSessions();
    const settingsBefore = world.usersSettings();
    expect(sessionsBefore).toEqual(['notes', 'work']);
    expect(settingsBefore.prefix).toBe('C-q');

    // 2. Taking the offer lands in a session of theirs, on screen.
    await (await driver.$('[data-testid="own-tmux-use"]')).click();
    await waitForTerminalText(driver, world.marker('notes'), 30000);
    expect(await attachedSession()).toBe('notes');
    expect(world.usersAttachedSessions()).toEqual(['notes']);

    // 3. The notice stays to say how to start there next time, until closed.
    await waitForCondition(
      null,
      async () => (await notice())?.stage === 'switched',
      15000,
      'the notice to say the switch was made',
    );
    const switched = await notice();
    expect(switched.stage).toBe('switched');
    expect(switched.text).toContain('TMUX_SOCKET=default');
    expect(switched.buttons).toEqual(['Got it']);
    await (await driver.$('[data-testid="own-tmux-dismiss"]')).click();
    await waitForCondition(null, async () => (await notice()) === null, 10000, 'the notice to go');

    // 4. The answer is on disk, so no later launch asks again.
    expect(JSON.parse(fs.readFileSync(world.stateFile, 'utf8')).own_tmux_asked).toBe(true);

    // 5. Their tmux is as they left it: the same sessions and no other
    //    (tmuxy made none of its own there), their prefix, their status line
    //    and their binding.
    expect(world.usersSessions()).toEqual(sessionsBefore);
    expect(world.usersSettings()).toEqual(settingsBefore);
  });
});
