/**
 * Session snapshots: a session's shape survives the tmux server dying.
 *
 * One test, because it is one feature with one promise: build a session the
 * way a user does, lose the tmux server, start tmuxy again, and find the same
 * session — the split, the float, the second tab, the pane group, the sidebar
 * column, the browser pane — with every pane in its directory and its program
 * offered at the prompt rather than run.
 *
 * It runs on a server of its own (`isolatedServer`): the point of the test is
 * `kill-server`, which the shared suite server cannot survive. The proof that
 * the shape came back whole is not a hand-picked list of selectors but the
 * snapshot itself: the restored session is saved again and must equal what
 * was saved before the kill, tag for tag and layout for layout. The UI is
 * then checked for what a user would look for — the float on screen, the
 * offered command at the prompt — rather than for DOM presence.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBrowser, waitForCondition, sendPrefixCommand } = require('./helpers');
const { TMUXY_PORT } = require('./helpers/config');
const { isolatedServer } = require('./helpers/snapshot-server');

const SNAPSHOT_PORT = TMUXY_PORT + 200;
const SESSION = 'snapshot';
/** A second session, made and killed so the menu has an exited one to offer. */
const SPARE = 'spare';

/** The snapshot JSON, without the one field a save is allowed to change. */
function shapeOf(file) {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete snapshot.saved_at;
  return snapshot;
}

/**
 * A tmux layout reduced to its tree: `d363,139x27,0,0[139x13,0,0,0,…]`
 * becomes `P[P,P]`. The checksum, every size and every pane id are the
 * client's and tmux's to assign, and a restored session is sized by the
 * client that attaches to it next — the splits are what was saved.
 */
function layoutTree(layout) {
  return layout.replace(/^[0-9a-f]{4},/, '').replace(/\d+x\d+,\d+,\d+(,\d+)?/g, 'P');
}

/**
 * What one snapshot must share with another for the session to count as the
 * same one: windows by index, type, parent and layout tree; panes by index,
 * directory, tags and the program's own word. Not `command`: that is what
 * `ps` saw in the foreground at that moment, and the restore OFFERS it at the
 * prompt rather than running it, so a save after the restore sees a shell.
 */
function comparable(shape) {
  return {
    windows: shape.windows.map((w) => ({
      ...w,
      layout: layoutTree(w.layout),
      panes: w.panes.map(({ command, ...pane }) => pane),
    })),
    // The group's member parked out of view comes back parked, in its group.
    hidden: (shape.hidden ?? []).map(({ command, ...member }) => member),
  };
}

/** A Chromium the browser pane can launch, or null with the reason printed. */
function engineOrSkip() {
  const named = process.env.TMUXY_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (named && fs.existsSync(named)) return named;
  const usual = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = usual.find((p) => fs.existsSync(p));
  if (!found)
    console.warn('session-snapshot: no Chromium-family browser, the browser pane is left out');
  return found ?? null;
}

describe('Scenario 32: Session snapshots', () => {
  const scratch = path.join(os.tmpdir(), `tmuxy-snapshot-e2e-${process.pid}`);
  const stateDir = path.join(scratch, 'state');
  const srv = isolatedServer({
    port: SNAPSHOT_PORT,
    socket: `tmuxy-snapshot-${process.pid}`,
    session: SESSION,
    stateDir,
  });
  let browser;
  let page;

  beforeAll(async () => {
    fs.mkdirSync(scratch, { recursive: true });
    // Typed as a short path: a long command line into a pane drops characters.
    fs.writeFileSync(
      path.join(scratch, 'run'),
      `#!/bin/sh\nexport TMUXY_STATE_DIR=${stateDir}\nexec ${path.join(process.cwd(), 'bin/tmuxy-cli')} browser --repl --session e2e\n`,
      { mode: 0o755 },
    );
    browser = await getBrowser();
    await srv.start();
  }, 120000);

  afterAll(async () => {
    try {
      if (page) await page.close();
    } catch {
      // The page may already be gone with its server.
    }
    await srv.stop();
    srv.killTmux();
    // A browser profile under the state dir may still be being written by a
    // Chromium on its way out; the retries outlast it.
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }, 60000);

  /** A page on the isolated server, attached and showing at least one window. */
  async function openPage() {
    const p = await browser.newPage();
    await p.goto(`${srv.url}/?session=${SESSION}`);
    await waitForCondition(
      p,
      () => p.evaluate(() => (window.app?.getSnapshot?.()?.context?.windows?.length ?? 0) > 0),
      60000,
      'the isolated server to show a session',
    );
    return p;
  }

  test('the shape survives kill-server: split, float, tab, group, sidebar, browser pane, offered commands', async () => {
    page = await openPage();

    // 1. Build the session the way a user does: through the CLI and the keys.
    //    Order matters for one of them: `pane group add` groups tmux's CURRENT
    //    pane, so it runs right after the split, while the split pane is the
    //    current one — before a float or a tab has moved the focus elsewhere.
    srv.cli(['pane', 'split', '-v']);
    srv.cli(['pane', 'group', 'add']);
    srv.cli(['pane', 'float', '--width', '60', '--height', '20']);
    // `tab create` answers with the new window's id, which is how it is
    // selected later: a bare index is tmux's and depends on `base-index`.
    const secondTab = srv.cli(['tab', 'create']);
    // The sidebar column is a window of its own, opened from the client.
    await page.bringToFront();
    await sendPrefixCommand(page, 't');
    await waitForCondition(
      page,
      () => page.evaluate(() => window.app.getSnapshot().context.leftSidebarOpen === true),
      15000,
      'the left sidebar to open',
    );
    // What a pane says it should come back as.
    srv.cli(['pane', 'restore-cmd', 'echo restored-ok', '%0']);
    // A browser pane writes that tag itself, with the page it is on.
    const engine = engineOrSkip();
    if (engine) {
      // Started the way another pane or an agent starts it — `tmuxy pane
      // send` into the second tab's pane — and read back with `pane capture`,
      // the same pair a script uses to drive it. Not typed through the page:
      // with a float and a sidebar open, `.pane-active` is not that tab.
      srv.cli(['tab', 'select', secondTab]);
      srv.cli(['pane', 'send', `${scratch}/run`, 'Enter']);
      const tell = (args) => {
        try {
          return srv.cli(args);
        } catch (error) {
          return String(error.message);
        }
      };
      await waitForCondition(
        page,
        () => srv.cli(['pane', 'capture']).includes('about:blank'),
        60000,
        // On failure the message carries what the panes were doing, which is
        // the only thing worth knowing about a pane that did not start.
        () =>
          `the browser pane to start in the second tab\npanes: ${tell(['pane', 'list', '--all', '--json'])}\nactive pane shows:\n${tell(['pane', 'capture'])}`,
      );
    }

    // 2. The autosave has followed every change: the latest snapshot holds
    //    the float, the group, the sidebar and the restore tags.
    const latest = path.join(srv.snapshotDir, `${SESSION}.latest.json`);
    await waitForCondition(
      page,
      () => {
        if (!fs.existsSync(latest)) return false;
        const shape = shapeOf(latest);
        const types = shape.windows.map((w) => w.window_type).filter(Boolean);
        const panes = shape.windows.flatMap((w) => w.panes);
        return (
          types.includes('float') &&
          types.includes('sidebar-left') &&
          panes.some((p) => p.options && p.options['@tmuxy-group-id']) &&
          (shape.hidden ?? []).length === 1 &&
          panes.some((p) => p.restore_command === 'echo restored-ok') &&
          (!engine ||
            panes.some((p) => (p.restore_command ?? '').startsWith('tmuxy browser --repl')))
        );
      },
      30000,
      // On failure, what the snapshot does hold is the whole diagnosis.
      () =>
        `the autosave to record the whole shape\nlatest snapshot: ${fs.existsSync(latest) ? fs.readFileSync(latest, 'utf8') : '(none)'}`,
    );
    const before = shapeOf(latest);
    expect(before.windows.length).toBeGreaterThanOrEqual(4);

    // 3. Lose everything: the server goes down the way a reboot takes it
    //    (SIGTERM, with a last save), then the tmux server itself.
    await page.close();
    page = null;
    await srv.stop();
    srv.killTmux();
    expect(() => srv.cli(['tab', 'list'])).toThrow();

    // 4. Start again. A missing session with a snapshot is rebuilt onto the
    //    window the server creates, over control mode, after attach.
    await srv.start();
    page = await openPage();
    await waitForCondition(
      page,
      () => page.evaluate(() => window.app.getSnapshot().context.windows.length),
      60000,
      'the restored session to show its windows',
    );

    // 5. Saved again, the restored session IS the one that was lost: the same
    //    windows and splits, the same tags, the same offered programs. The
    //    rebuild runs after attach, a command at a time, so a save that does
    //    not match yet is a rebuild still under way — the wait is for the
    //    match, and what it reports on giving up is how far the rebuild got
    //    and what the server said about it.
    const wanted = JSON.stringify(comparable(before));
    const saved = () => {
      srv.cli(['session', 'save', SESSION]);
      return comparable(shapeOf(latest));
    };
    await waitForCondition(
      page,
      () => JSON.stringify(saved()) === wanted,
      90000,
      () =>
        `the restored session to match the one that was lost\nwanted: ${wanted}\ngot:    ${JSON.stringify(saved())}\nserver: ${srv.serverLog()}`,
    );

    // 6. And what the user sees: the float is on screen over the tab it was
    //    opened from (a float shows only over its parent tab, and the session
    //    came back on the tab that was current), and the program is offered
    //    at the prompt — typed, not run.
    //    The first tab is the lowest index the strip lists, whatever
    //    `base-index` made that number.
    const listed = srv.cli(['tab', 'list', '--json']);
    const [firstTab] = JSON.parse(listed).sort((a, b) => a.index - b.index);
    if (!firstTab) {
      throw new Error(
        `the restored session lists no tab\ntab list: ${listed}\npanes: ${srv.cli(['pane', 'list', '--all', '--json'])}\nserver: ${srv.serverLog()}`,
      );
    }
    srv.cli(['tab', 'select', firstTab.id]);
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const el = document.querySelector('.float-container');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 40 && r.height > 20;
        }),
      30000,
      async () =>
        `the restored float to be visible over ${firstTab.id}\ntab list: ${listed}\nclient: ${await page.evaluate(
          () => {
            const c = window.app.getSnapshot().context;
            return JSON.stringify({
              active: c.activeWindowId,
              windows: c.windows.map((w) => [w.id, w.index, w.windowType, w.floatParent]),
              floats: Object.keys(c.floatPanes),
            });
          },
        )}\nserver: ${srv.serverLog()}`,
    );
    const offered = srv.cli(['pane', 'capture', '%0']);
    expect(offered).toContain('echo restored-ok');
    expect(offered).not.toContain('restored-ok\n');

    // 7. An exited session with a snapshot is offered in the session menu,
    //    opened from the status line with the tree sidebar closed (the menu
    //    must read the list as it opens, not wait for the tree's poll), and
    //    choosing it rebuilds the session and switches to it.
    if (await page.evaluate(() => window.app.getSnapshot().context.leftSidebarOpen)) {
      await sendPrefixCommand(page, 't');
      await waitForCondition(
        page,
        () => page.evaluate(() => window.app.getSnapshot().context.leftSidebarOpen === false),
        15000,
        'the tree sidebar to close',
      );
    }
    srv.cli(['run', `new-session -d -s ${SPARE}`]);
    srv.cli(['session', 'save', SPARE]);
    srv.cli(['run', `kill-session -t ${SPARE}`]);
    await page.click('.statusline-session');
    const row = `[data-restore-session="${SPARE}"]`;
    await waitForCondition(
      page,
      () =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 8;
        }, row),
      15000,
      async () =>
        `the exited session to be offered in the menu\nrestorable: ${await page.evaluate(() =>
          JSON.stringify(window.app.getSnapshot().context.restorableSessions),
        )}\nsnapshots: ${srv.cli(['session', 'snapshots'])}`,
    );
    await page.click(row);
    await waitForCondition(
      page,
      () => page.evaluate((name) => window.app.getSnapshot().context.sessionName === name, SPARE),
      30000,
      async () =>
        `the client to switch to the rebuilt session\non: ${await page.evaluate(
          () => window.app.getSnapshot().context.sessionName,
        )}\nsessions: ${srv.cli(['run', 'list-sessions -F "#{session_name}"'])}\nserver: ${srv.serverLog()}`,
    );

    // 8. Forgetting is deliberate and separate from killing: the running
    //    session stays unless --force, and then nothing is left to list.
    //    The sessions on the server going in, and the server's own account,
    //    are what a forget that finds no tmux server left needs to be read
    //    (CI has seen the second forget find the server gone).
    //    `##` keeps run-shell from expanding the format in its own session,
    //    which would print that one name once per session.
    const sessions = () => {
      try {
        return srv.cli(['run', 'list-sessions -F "##{session_name} ##{session_attached}"']);
      } catch (error) {
        return `(${error.message})`;
      }
    };
    const sessionsBefore = sessions();
    let sessionsBetween = '(not reached)';
    const forget = (...args) => {
      try {
        return srv.cli(['session', 'forget', ...args]);
      } catch (error) {
        throw new Error(
          `${error.message}\nsessions before forgetting: ${sessionsBefore}\nsessions after the first forget: ${sessionsBetween}\nserver: ${srv.serverLog()}`,
        );
      }
    };
    expect(() => srv.cli(['session', 'forget', SESSION])).toThrow();
    forget(SESSION, '--force');
    sessionsBetween = sessions();
    forget(SPARE, '--force');
    expect(srv.cli(['session', 'snapshots'])).not.toContain(SESSION);
  }, 300000);
});
