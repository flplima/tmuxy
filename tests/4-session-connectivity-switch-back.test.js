/**
 * Session & Connectivity E2E Tests (switching back to the session just left)
 *
 * A session another client is watching keeps its monitor, as one left a
 * moment ago does (the server's grace). A client that switches to it meets a
 * monitor with nothing new to say: it has to ask for the session's state
 * itself, or it shows the empty frame the switch left. A second page stays on
 * the first session for the whole test, so its monitor is up whatever the
 * runner's speed: without the fix this test fails every time, not only when
 * the switch back lands inside the grace.
 */

const {
  describeE2E,
  focusPage,
  openSession,
  waitForCondition,
  waitForShellPrompt,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');
const { waitForMonitorGone } = require('./helpers/monitor');

/** The session the page drives, as its address names it. */
const pageSession = (page) =>
  page.evaluate(() => new URL(window.location.href).searchParams.get('session'));

/** Pick `name` in the status line's session switcher, as a user does. */
async function pickSession(page, name) {
  const item = `[data-session-name="${name}"]`;
  await waitForCondition(
    page,
    async () => {
      const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const r = el?.getBoundingClientRect();
        return r ? r.height : 0;
      }, item);
      if (box > 0) return true;
      await page.click('.statusline-session');
      return false;
    },
    15000,
    `${name} to be offered in the session switcher`,
  );
  await page.click(item);
}

/** The terminal the page shows for `paneId`, when it is drawn with a size. */
const drawn = (page, paneId) =>
  page.evaluate((id) => {
    const log = document.querySelector(`[data-pane-id="${id}"] [role="log"]`);
    const box = log?.getBoundingClientRect();
    return !!box && box.width > 50 && box.height > 50;
  }, paneId);

describeE2E('Scenario: switching back to the session just left', {}, (ctx) => {
  test('a session another client keeps open is drawn as soon as it is picked', async () => {
    // Setup: a second session on the socket, made before any client attaches.
    const other = `tmuxy_back_${Date.now()}`;
    tmuxExec(`new-session -d -s ${other} -x 200 -y 50`);
    let watcher = null;
    try {
      const { page } = ctx;
      await ctx.setupPage();
      await focusPage(page);
      await waitForShellPrompt(page);
      const here = ctx.session.name;
      const activePane = () => page.evaluate(() => window.app?.view().activePaneId ?? null);
      const first = await activePane();
      // A second client on the first session, for the whole test.
      watcher = await ctx.browser.newPage();
      await openSession(watcher, here);

      await pickSession(page, other);
      await waitForCondition(
        page,
        async () => (await pageSession(page)) === other && (await activePane()) !== null,
        15000,
        'the other session to be drawn',
      );

      // Back to the first session, whose monitor the second page keeps up.
      await pickSession(page, here);
      await waitForCondition(
        page,
        async () =>
          (await pageSession(page)) === here &&
          (await activePane()) === first &&
          (await drawn(page, first)),
        10000,
        async () =>
          `the first session's pane ${first} to be drawn again; the page is on ${await pageSession(page)} with pane ${await activePane()}`,
      );
    } finally {
      await watcher?.close();
      try {
        tmuxExec(`kill-session -t ${other}`);
      } catch {
        // Already gone.
      }
      await waitForMonitorGone(other);
    }
  }, 120000);
});
