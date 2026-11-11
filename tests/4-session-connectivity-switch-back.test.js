/**
 * Session & Connectivity E2E Tests (switching back to the session just left)
 *
 * The server keeps a session's monitor for a moment after its last client
 * leaves, so a reload finds it warm. A client that switches back within that
 * moment meets a monitor with nothing new to say: it has to ask for the
 * session's state itself, or it shows the empty frame the switch left.
 */

const { describeE2E, focusPage, waitForCondition, waitForShellPrompt } = require('./helpers');
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
  test('a session left a moment ago is drawn again as soon as it is picked', async () => {
    // Setup: a second session on the socket, made before any client attaches.
    const other = `tmuxy_back_${Date.now()}`;
    tmuxExec(`new-session -d -s ${other} -x 200 -y 50`);
    try {
      const { page } = ctx;
      await ctx.setupPage();
      await focusPage(page);
      await waitForShellPrompt(page);
      const here = ctx.session.name;
      const activePane = () => page.evaluate(() => window.app?.view().activePaneId ?? null);
      const first = await activePane();

      await pickSession(page, other);
      await waitForCondition(
        page,
        async () => (await pageSession(page)) === other && (await activePane()) !== null,
        15000,
        'the other session to be drawn',
      );

      // Straight back, well inside the moment the first session's monitor is kept.
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
      try {
        tmuxExec(`kill-session -t ${other}`);
      } catch {
        // Already gone.
      }
      await waitForMonitorGone(other);
    }
  }, 120000);
});
