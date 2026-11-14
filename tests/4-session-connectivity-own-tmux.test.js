/**
 * The launch notice about the user's own tmux server.
 *
 * Someone with tmux sessions running opens tmuxy, sees one empty session and
 * takes their work for gone, or tmuxy for broken: it runs on a socket of its
 * own. A tmuxy that nobody pointed at a socket says so once, with how many
 * sessions wait on the other one and how to get to them.
 *
 * It runs in a world of its own (`ownTmuxWorld`): a stand-in for the user's
 * tmux and a tmuxy server started the way a released one is, both in a
 * private socket directory. The suite's shared server names its socket, which
 * is an answer already, so it never shows the notice.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getBrowser,
  waitForCondition,
  focusPage,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
} = require('./helpers');
const { TMUXY_PORT } = require('./helpers/config');
const { ownTmuxWorld } = require('./helpers/own-tmux');

describe('Scenario 22e: The user has tmux sessions of their own', () => {
  const root = path.join(os.tmpdir(), `tmuxy-own-tmux-e2e-${process.pid}`);
  const world = ownTmuxWorld({ port: TMUXY_PORT + 120, root });
  let page;

  beforeAll(async () => {
    world.startUsersTmux(['notes', 'work']);
    await world.start();
  }, 120000);

  afterAll(async () => {
    try {
      if (page) await page.close();
    } catch {
      // The page may already be gone with its server.
    }
    await world.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60000);

  /** What the host answered this page about the user's own tmux. */
  const hostsAnswer = (p) =>
    p.waitForResponse((response) =>
      (response.request().postData() ?? '').includes('"own_tmux_offer"'),
    );

  async function shownPane(p) {
    await waitForCondition(
      p,
      () =>
        p.evaluate(
          () =>
            Boolean(window.app?.view?.().activePaneId) &&
            document.querySelector('.pane-layout-item[data-pane-id]') !== null,
        ),
      60000,
      'the server beside the user’s tmux to show a pane',
    );
  }

  test('a launch says where the sessions are and how to reach them → typing still works → the answer is remembered', async () => {
    page = await (await getBrowser()).newPage();
    const notice = page.locator('[data-testid="own-tmux-notice"]');

    // 1. The app opens on its own empty session, and says why the user's
    //    two are not in it.
    const offered = hostsAnswer(page);
    await page.goto(`${world.url}/?session=main`);
    await shownPane(page);
    // The server under test is on its socket inside this world, not on a
    // live one of the same name.
    expect(world.attachedInside()).toEqual(['main']);
    // The session a switch would open is the first by name, and this host
    // cannot make the switch.
    expect(await (await offered).json()).toEqual({
      result: { serverId: 'my-tmux', sessions: 2, session: 'notes', canSwitch: false },
    });
    await notice.waitFor({ state: 'visible', timeout: 20000 });
    const text = await notice.innerText();
    expect(text).toContain('Your tmux has 2 sessions on its default socket');
    expect(text).toContain('tmuxy runs on a socket of its own');
    // A web server serves the socket it was started on: it says how to start
    // on the other one, and offers no switch it could not make.
    expect(text).toContain('TMUX_SOCKET=default');
    expect(await page.locator('[data-testid="own-tmux-use"]').count()).toBe(0);
    // On screen, with a real box inside the window, not merely in the DOM.
    const box = await notice.boundingBox();
    const viewport = page.viewportSize();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(20);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

    // 2. The notice covers nothing and holds no key: the pane takes typing.
    const token = `BESIDE_THE_NOTICE_${Date.now()}`;
    await focusPage(page);
    await typeInTerminal(page, `echo ${token}`);
    await pressEnter(page);
    await waitForTerminalText(page, token, 15000, { notOnLineWith: 'echo' });
    expect(await notice.isVisible()).toBe(true);

    // 3. Answered, it goes.
    await page.locator('[data-testid="own-tmux-dismiss"]').click();
    await notice.waitFor({ state: 'detached', timeout: 10000 });

    // 4. And stays gone: the next launch asks the host, which says nothing.
    const answered = hostsAnswer(page);
    await page.reload();
    await shownPane(page);
    expect(await (await answered).json()).toEqual({ result: null });
    expect(await notice.count()).toBe(0);

    // 5. What is remembered is that this host told, not an answer to the
    //    switch only the desktop app can offer: that one is still to be made.
    expect(JSON.parse(fs.readFileSync(world.stateFile, 'utf8'))).toMatchObject({
      own_tmux_told: true,
    });
    expect(JSON.parse(fs.readFileSync(world.stateFile, 'utf8')).own_tmux_asked).toBeUndefined();

    // 6. Looking at the user's tmux changed nothing on it.
    expect(world.usersSessions()).toEqual(['notes', 'work']);
    expect(world.usersSettings().prefix).toBe('C-q');
  }, 180000);
});
