/**
 * Session & Connectivity E2E Tests (the last pane closing)
 *
 * When the last pane of the attached session exits, the session is gone and
 * tmux closes the app's client. The app shows its detached overlay, which must
 * not offer the session that just ended, and must offer a new one: before the
 * fix it listed the dead session as current and had no way to start another.
 */

const {
  describeE2E,
  focusPage,
  typeInTerminal,
  pressEnter,
  waitForPaneCount,
  waitForShellPrompt,
  waitForTerminalText,
  splitPaneKeyboard,
  waitForCondition,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

/** The sessions tmux has, the app's hidden ones (`__tmuxy_stash`) aside. */
const tmuxSessions = () => {
  let out = '';
  try {
    out = tmuxExec("list-sessions -F '#{session_name}'");
  } catch {
    // No session at all: tmux says so on stderr.
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && !name.startsWith('__tmuxy'));
};

/** The detached overlay's options, top to bottom, each with whether it is drawn. */
const overlayOptions = (page) =>
  page.evaluate(() => {
    const overlay = document.querySelector('.connection-overlay-detached');
    if (!overlay) return null;
    const box = overlay.querySelector('.connection-overlay-card').getBoundingClientRect();
    return {
      shown: box.width > 0 && box.height > 0,
      text: overlay.querySelector('.connection-overlay-text')?.textContent ?? '',
      options: [...overlay.querySelectorAll('[role="option"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: el.textContent.trim(),
          selected: el.getAttribute('aria-selected') === 'true',
          visible: r.width > 0 && r.height > 0,
        };
      }),
    };
  });

describeE2E('Scenario: the last pane closes', {}, (ctx) => {
  test('the overlay offers a new session first and not the one that ended; Enter starts it', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await focusPage(page);
    await waitForShellPrompt(page);
    const ended = ctx.session.name;
    const before = tmuxSessions().filter((name) => name !== ended);
    let fresh = null;
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    await waitForShellPrompt(page);

    // Both panes exit, the way a user closes them.
    await typeInTerminal(page, 'exit');
    await pressEnter(page);
    await waitForPaneCount(page, 1);
    await typeInTerminal(page, 'exit');
    await pressEnter(page);

    let seen = null;
    await waitForCondition(
      page,
      async () => {
        seen = await overlayOptions(page);
        return !!seen?.shown && seen.options.length > 0;
      },
      15000,
      'the detached overlay to be drawn',
    );
    // The client hears `%exit` before tmux is done freeing the session: a
    // slow runner can still list it for a moment.
    await waitForCondition(
      page,
      async () => !tmuxSessions().includes(ended),
      15000,
      'tmux to forget the session that ended',
    );
    expect(seen.text).toBe('The session ended.');
    expect(seen.options[0]).toMatchObject({ label: 'New session', visible: true, selected: true });
    expect(seen.options.map((o) => o.label).join('\n')).not.toContain(ended);

    // Enter takes the highlighted option.
    await page.keyboard.press('Enter');
    await waitForCondition(
      page,
      async () => {
        const drawn = await page.evaluate(() => {
          const log = document.querySelector('[data-pane-id] [role="log"]');
          const box = log?.getBoundingClientRect();
          return (
            !document.querySelector('.connection-overlay') &&
            !!box &&
            box.width > 50 &&
            box.height > 50
          );
        });
        fresh = await page.evaluate(() =>
          new URL(window.location.href).searchParams.get('session'),
        );
        return drawn;
      },
      15000,
      'a pane of the new session to be drawn',
    );
    // The teardown kills the session the page is on now, and waits for its
    // monitor to go.
    if (fresh) ctx.session.name = fresh;
    expect(fresh).not.toBe(ended);
    expect(tmuxSessions().filter((name) => !before.includes(name))).toEqual([fresh]);

    await waitForShellPrompt(page);
    await typeInTerminal(page, 'echo ok-$((40+2))');
    await pressEnter(page);
    await waitForTerminalText(page, 'ok-42');
  });
});
