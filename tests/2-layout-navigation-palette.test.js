/**
 * The command palette: Ctrl+Shift+P, type, Enter. Every step is the user's
 * own — the keys they press and the rows they read on screen — and what is
 * checked is what the palette did to the panes and the session.
 */

const {
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForCondition,
  waitForPaneCount,
  waitForLayoutSettled,
  sendPrefixCommand,
  shownPanes,
  GRID_PANE,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');
const { waitForMonitorGone } = require('./helpers/monitor');

const PALETTE = '[data-testid="command-palette"]';

/** The session the page drives, as its address names it. */
const pageSession = (page) =>
  page.evaluate(() => new URL(window.location.href).searchParams.get('session'));

/**
 * The palette as a user sees it: its box, whether the keyboard is in its
 * field, and the rows inside the list's own box (a row scrolled out of the
 * list is in the DOM and not on screen).
 */
const readPalette = (page) =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const panel = root?.querySelector('[role="dialog"]');
    if (!root || !panel) return null;
    const box = panel.getBoundingClientRect();
    const list = panel.querySelector('[role="listbox"]').getBoundingClientRect();
    const input = panel.querySelector('input');
    // The topmost element at the panel's middle is the panel's own: nothing covers it.
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    const rows = [...panel.querySelectorAll('[role="option"]')]
      .filter((row) => {
        const r = row.getBoundingClientRect();
        return r.height > 0 && r.top >= list.top - 1 && r.bottom <= list.bottom + 1;
      })
      .map((row) => ({
        id: row.dataset.entryId,
        kind: row.dataset.entryKind,
        label: row.querySelector('.command-palette-label')?.textContent ?? '',
        detail: row.querySelector('.command-palette-detail')?.textContent ?? '',
        key: row.querySelector('.command-palette-key')?.textContent ?? '',
        selected: row.getAttribute('aria-selected') === 'true',
      }));
    return {
      mode: root.dataset.mode,
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      uncovered: top !== null && panel.contains(top),
      typingInIt: document.activeElement === input,
      query: input.value,
      rows,
    };
  }, PALETTE);

/** Wait for the palette to be open, wholly on screen, with the keyboard in its field. */
async function waitForPalette(page) {
  let seen = null;
  await waitForCondition(
    page,
    async () => {
      seen = await readPalette(page);
      if (!seen) return false;
      const { box, viewport } = seen;
      const onScreen =
        box.left >= 0 && box.top >= 0 && box.right <= viewport.w && box.bottom <= viewport.h;
      return onScreen && box.right - box.left > 200 && seen.uncovered && seen.typingInIt;
    },
    10000,
    () => `the palette to open on screen with the keyboard in it\n${JSON.stringify(seen)}`,
  );
  return seen;
}

const waitForPaletteGone = (page) =>
  waitForCondition(
    page,
    async () => (await readPalette(page)) === null,
    10000,
    'the palette to close',
  );

/** Wait until the palette's rows satisfy `test`, and return them. */
async function waitForRows(page, test, description) {
  let rows = [];
  await waitForCondition(
    page,
    async () => {
      rows = (await readPalette(page))?.rows ?? [];
      return test(rows);
    },
    15000,
    () => `${description}\nrows: ${JSON.stringify(rows)}`,
  );
  return rows;
}

/** The text every pane on screen shows, joined. */
const screenText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane-container [role="log"]')]
      .map((el) => el.textContent)
      .join('\n'),
  );

describeE2E('Command palette', {}, (ctx) => {
  test('Ctrl+Shift+P opens it → "split" offers both splits with their keys → Enter splits the pane', async () => {
    await ctx.setupPage();
    await waitForPaneCount(ctx.page, 1, 15000);

    await ctx.page.keyboard.press('Control+Shift+P');
    const opened = await waitForPalette(ctx.page);
    expect(opened.mode).toBe('all');

    await ctx.page.keyboard.type('split');
    const rows = await waitForRows(
      ctx.page,
      (found) => found.length >= 2 && found[0].label === 'Split Pane Below',
      'both splits to lead the results',
    );
    expect(rows.slice(0, 2).map((row) => row.label)).toEqual([
      'Split Pane Below',
      'Split Pane Right',
    ]);
    // Each shows the key that does the same: the prefix, then the binding's key.
    for (const row of rows.slice(0, 2)) expect(row.key).toMatch(/^ctrl\+a \S+$/);
    expect(rows[0].key).not.toBe(rows[1].key);
    expect(rows[0].selected).toBe(true);
    expect((await readPalette(ctx.page)).query).toBe('split');

    // Enter runs the highlighted one: a second pane, below the first.
    await ctx.page.keyboard.press('Enter');
    await waitForPaletteGone(ctx.page);
    await waitForPaneCount(ctx.page, 2, 15000);
    // The panes slide to their places after a split: read them once they are there.
    await waitForLayoutSettled(ctx.page);
    const boxes = await shownPanes(ctx.page, GRID_PANE);
    expect(boxes).toHaveLength(2);
    const [upper, lower] = boxes.map((pane) => pane.box).sort((a, b) => a.top - b.top);
    expect(upper.height).toBeGreaterThan(40);
    expect(lower.height).toBeGreaterThan(40);
    expect(lower.top).toBeGreaterThanOrEqual(upper.bottom - 2);
    expect(Math.abs(upper.left - lower.left)).toBeLessThan(4);

    // What was typed went to the palette, not to the shell under it.
    expect(await screenText(ctx.page)).not.toContain('split');

    // And the keyboard is back in the panes: a command typed now runs.
    await typeInTerminal(ctx.page, 'echo back_in_$((20 + 3))_pane');
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => (await screenText(ctx.page)).includes('back_in_23_pane'),
      15000,
      'a command typed after the palette closed to run in the pane',
    );

    // The prefix and P is the other way in, for a browser that keeps the
    // chord to itself; Escape puts it away.
    await sendPrefixCommand(ctx.page, 'P');
    expect((await waitForPalette(ctx.page)).mode).toBe('all');
    await ctx.page.keyboard.press('Escape');
    await waitForPaletteGone(ctx.page);
  }, 120000);

  test('a pane in another session: the palette lists it, and Enter switches session and lands on that pane', async () => {
    const other = `tmuxy_palette_${Date.now()}`;
    await ctx.setupPage();
    const home = ctx.session.name;
    // A sibling session the UI cannot create with a name of the test's own.
    tmuxExec(`new-session -d -s ${other} -x 200 -y 50`);

    const paneRunning = (session, command) =>
      tmuxExec(`list-panes -s -t ${session} -F '#{pane_id} #{pane_current_command}'`)
        .split('\n')
        .map((line) => line.split(' '))
        .find(([, running]) => running === command)?.[0];
    const activePaneOf = (session) => tmuxExec(`display-message -p -t ${session} '#{pane_id}'`);
    /** The pane the page draws as the one in front, and where it is. */
    const activeOnScreen = async () => {
      const id = await ctx.page.evaluate(() => window.app?.view().activePaneId ?? null);
      const box = (await shownPanes(ctx.page, GRID_PANE)).find((pane) => pane.id === id);
      return box ? id : null;
    };

    try {
      // Go to the sibling through the palette's places (prefix g), by name.
      await sendPrefixCommand(ctx.page, 'g');
      expect((await waitForPalette(ctx.page)).mode).toBe('go');
      await ctx.page.keyboard.type(other);
      const sessionRows = await waitForRows(
        ctx.page,
        (found) => found[0]?.id === `session:${other}`,
        'the sibling session to lead the places',
      );
      expect(sessionRows.every((row) => row.kind !== 'action')).toBe(true);
      await ctx.page.keyboard.press('Enter');
      await waitForPaletteGone(ctx.page);
      await waitForCondition(
        ctx.page,
        async () => (await pageSession(ctx.page)) === other,
        20000,
        'the page to move to the sibling session',
      );
      await waitForPaneCount(ctx.page, 1, 20000);

      // There: a long-running program in the first pane, then a second pane,
      // which is the one tmux leaves in front.
      await typeInTerminal(ctx.page, 'sleep 600');
      await pressEnter(ctx.page);
      await waitForCondition(
        ctx.page,
        async () => Boolean(paneRunning(other, 'sleep')),
        15000,
        'sleep to be running in the sibling session',
      );
      const target = paneRunning(other, 'sleep');
      // `prefix %`, typed: the split helper waits for a prompt in every pane,
      // and this one is asleep on purpose.
      await sendPrefixCommand(ctx.page, '5', { shift: true });
      await waitForPaneCount(ctx.page, 2, 15000);
      await waitForLayoutSettled(ctx.page);
      expect(activePaneOf(other)).not.toBe(target);

      // Back home, again through the palette.
      await sendPrefixCommand(ctx.page, 'g');
      await waitForPalette(ctx.page);
      await ctx.page.keyboard.type(home);
      await waitForRows(
        ctx.page,
        (found) => found[0]?.id === `session:${home}`,
        'the first session to lead the places',
      );
      await ctx.page.keyboard.press('Enter');
      await waitForPaletteGone(ctx.page);
      await waitForCondition(
        ctx.page,
        async () => (await pageSession(ctx.page)) === home,
        20000,
        'the page to come back to the first session',
      );
      await waitForPaneCount(ctx.page, 1, 20000);

      // From here, the sleeping pane is one search away. The sibling was left
      // a moment ago, so its monitor is still up and idle: a page that only
      // waited to be sent its state stayed empty here.
      await ctx.page.keyboard.press('Control+Shift+P');
      await waitForPalette(ctx.page);
      await ctx.page.keyboard.type('sleep');
      const rows = await waitForRows(
        ctx.page,
        (found) => found[0]?.id === `pane:${target}`,
        "the sibling session's sleeping pane to lead the results",
      );
      expect(rows[0].label.startsWith('sleep')).toBe(true);
      expect(rows[0].detail).toContain(other);
      await ctx.page.keyboard.press('Enter');
      await waitForPaletteGone(ctx.page);

      // The page is in the sibling session, both its panes are drawn, and the
      // one in front — on screen and in tmux — is the one that was picked.
      await waitForCondition(
        ctx.page,
        async () => (await pageSession(ctx.page)) === other,
        20000,
        'the page to move to the session the pane is in',
      );
      await waitForPaneCount(ctx.page, 2, 20000);
      await waitForCondition(
        ctx.page,
        async () => (await activeOnScreen()) === target && activePaneOf(other) === target,
        20000,
        async () =>
          `the picked pane ${target} to be in front; on screen: ${await activeOnScreen()}, in tmux: ${activePaneOf(other)}`,
      );
    } finally {
      try {
        tmuxExec(`kill-session -t ${other}`);
      } catch {
        // Already gone — fine.
      }
      await waitForMonitorGone(other);
    }
  }, 240000);
});
