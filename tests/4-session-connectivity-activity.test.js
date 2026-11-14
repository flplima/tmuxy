/**
 * Session & Connectivity E2E Tests (the activity inbox)
 *
 * With agents in several sessions the question is "who needs me?". The inbox
 * (`prefix A`) lists every pane on the server that declared a state, the one
 * that wants the user most first, and Enter goes to it wherever it is.
 * `prefix U` goes straight to the most urgent one.
 */

const {
  describeE2E,
  focusPage,
  sendPrefixCommand,
  waitForCondition,
  waitForShellPrompt,
  tmuxyCli,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');
const { waitForMonitorGone } = require('./helpers/monitor');

/** The session the page drives, as its address names it. */
const pageSession = (page) =>
  page.evaluate(() => new URL(window.location.href).searchParams.get('session'));

/** The inbox's rows as they are drawn, top to bottom; null while it is not up. */
function inboxRows(page) {
  return page.evaluate(() => {
    const inbox = document.querySelector('[data-testid="activity-inbox"]');
    if (!inbox || inbox.getBoundingClientRect().height === 0) return null;
    return [...inbox.querySelectorAll('[data-testid="activity-row"]')]
      .map((row) => {
        const box = row.getBoundingClientRect();
        return {
          paneId: row.dataset.paneId,
          state: row.dataset.state,
          text: row.textContent,
          top: box.top,
          shown: box.width > 0 && box.height > 0,
          selected: row.getAttribute('aria-selected') === 'true',
        };
      })
      .sort((a, b) => a.top - b.top);
  });
}

describeE2E('Scenario: the activity inbox', {}, (ctx) => {
  test('panes of two sessions are listed most urgent first, Enter goes to one in the other session, and prefix U to the next that needs you', async () => {
    // Setup (not the feature under test): a second session with two panes,
    // made before any client attaches, as a session someone else started.
    // One pane waits for an approval and says for what, the way a program
    // reports it (OSC 7501); the other is working and is the one in front.
    const other = `tmuxy_inbox_${Date.now()}`;
    tmuxExec(`new-session -d -s ${other} -x 200 -y 50 -n builds`);
    try {
      tmuxExec(`split-window -t ${other}`);
      const [waiting, working] = tmuxExec(`list-panes -t ${other} -F '#{pane_id}'`).split('\n');
      expect(waiting).toMatch(/^%\d+$/);
      expect(working).toMatch(/^%\d+$/);
      // "Apply 3 to add?"
      const asked = 'state=blocked:kind=permission:msg=QXBwbHkgMyB0byBhZGQ/';
      tmuxExec(`set-option -p -t ${waiting} @tmuxy-pane-state needs-input`);
      tmuxExec(`set-option -p -t ${waiting} @tmuxy-pane-status '${asked}'`);
      tmuxExec(`set-option -p -t ${working} @tmuxy-pane-state working`);
      expect(tmuxExec(`display-message -p -t ${other} '#{pane_id}'`)).toBe(working);

      const { page } = ctx;
      await ctx.setupPage();
      await focusPage(page);
      await waitForShellPrompt(page);
      const here = ctx.session.name;
      const failed = await page.evaluate(() => window.app?.view().activePaneId);
      tmuxyCli(['pane', 'state', 'error', failed]);

      // prefix A: the inbox, with all three, the question first.
      await sendPrefixCommand(page, 'A', { shift: true });
      let rows = null;
      await waitForCondition(
        page,
        async () => {
          rows = await inboxRows(page);
          const ours = (rows ?? []).filter((row) =>
            [waiting, failed, working].includes(row.paneId),
          );
          return ours.length === 3 && ours.every((row) => row.shown);
        },
        15000,
        async () => `the inbox to list the three panes; it shows ${JSON.stringify(rows)}`,
      );
      const ours = rows.filter((row) => [waiting, failed, working].includes(row.paneId));
      expect(ours.map((row) => [row.paneId, row.state])).toEqual([
        [waiting, 'needs-input'],
        [failed, 'error'],
        [working, 'working'],
      ]);
      expect(ours[0].text).toContain('Needs your approval: Apply 3 to add?');
      expect(ours[0].text).toContain(`${other} · builds`);
      expect(ours[1].text).toContain(here);
      // The highlight starts on the first row, the one Enter picks.
      expect(rows[0].paneId).toBe(waiting);
      expect(rows[0].selected).toBe(true);

      // Enter: the other session, on the pane that asked, not on the one
      // that session had in front.
      await page.keyboard.press('Enter');
      await waitForCondition(
        page,
        async () =>
          (await pageSession(page)) === other &&
          (await page.evaluate(() => window.app?.view().activePaneId)) === waiting,
        20000,
        async () =>
          `the client to be in ${other} on ${waiting}; it is in ${await pageSession(page)} on ${await page.evaluate(
            () => window.app?.view().activePaneId,
          )}`,
      );
      expect(await inboxRows(page)).toBeNull();
      expect(tmuxExec(`display-message -p -t ${other} '#{pane_id}'`)).toBe(waiting);
      await page.waitForSelector(`[data-pane-id="${waiting}"] [role="log"]`, { timeout: 15000 });

      // prefix U: the pane in front already has the user, so the next one
      // that needs them is the failed pane, back in the first session.
      await sendPrefixCommand(page, 'U', { shift: true });
      await waitForCondition(
        page,
        async () =>
          (await pageSession(page)) === here &&
          (await page.evaluate(() => window.app?.view().activePaneId)) === failed,
        20000,
        async () =>
          `prefix U to go back to ${failed} in ${here}; the client is in ${await pageSession(page)} on ${await page.evaluate(
            () => window.app?.view().activePaneId,
          )}`,
      );
    } finally {
      try {
        tmuxExec(`kill-session -t ${other}`);
      } catch {
        // Already gone.
      }
      await waitForMonitorGone(other);
    }
  }, 180000);
});
