/**
 * Input & Interaction E2E Tests (Copy Mode Search: / ? n N)
 */

const {
  describeE2E,
  focusPage,
  runCommand,
  getCopyModeState,
  waitForCondition,
  waitForCopyMode,
  enterCopyModeAndWait,
} = require('./helpers');

/** The highlighted match as the user sees it: its row's text and where it sits against the pane. */
async function currentMatch(page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="search-match-current"]');
    if (!box) return null;
    const row = box.dataset.row;
    const line = document.querySelector(`[data-testid="scrollback-terminal"] [data-row="${row}"]`);
    const pane = document.querySelector('.pane-scroll-container').getBoundingClientRect();
    const r = box.getBoundingClientRect();
    const cursor = document.querySelector('.terminal-cursor-copy')?.getBoundingClientRect();
    return {
      text: line?.textContent.trimEnd() ?? null,
      inPane: r.width > 0 && r.height > 0 && r.top >= pane.top && r.bottom <= pane.bottom,
      cursorOnMatch:
        !!cursor && Math.abs(cursor.top - r.top) < 2 && Math.abs(cursor.left - r.left) < 2,
    };
  });
}

/** Waits for the highlighted match to sit on the row that reads `text`, visible in the pane. */
async function matchOnRow(page, text) {
  let seen = null;
  await waitForCondition(
    page,
    async () => {
      seen = await currentMatch(page);
      return !!seen && seen.text === text && seen.inPane && seen.cursorOnMatch;
    },
    10000,
    () => `the search match on "${text}" (saw ${JSON.stringify(seen)})`,
  );
}

const promptText = (page) =>
  page.evaluate(
    () => document.querySelector('[data-testid="copy-search-bar"]')?.textContent ?? null,
  );

describeE2E('Scenario 11: Copy Mode Search', {}, (ctx) => {
  test('/ and ? search the whole history, n and N step between matches, Escape closes the prompt, then leaves', async () => {
    await ctx.setupPage();

    // The word is spelled in two pieces so the typed command does not hold it.
    // Deep enough that the first fetch (the newest rows) does not hold the oldest match.
    const cmd = `awk 'BEGIN{for(i=1;i<=1500;i++) print (i==300||i==900||i==1300) ? "row " i " zebra" "fish" : "row " i}'`;
    await runCommand(ctx.page, cmd, 'row 1500');
    await focusPage(ctx.page);

    const entry = await enterCopyModeAndWait(ctx.page);
    expect(entry.active).toBe(true);
    const keys = ctx.page.keyboard;

    // `/` opens the prompt, typing goes to it and not to the vi keys (j, k would move the cursor).
    await keys.type('/');
    await waitForCondition(
      ctx.page,
      async () => (await promptText(ctx.page)) === 'Search Down: ',
      5000,
      'the search-down prompt',
    );
    await keys.type('Zebrafish');
    await keys.press('Backspace');
    await keys.type('h');
    await waitForCondition(
      ctx.page,
      async () => (await promptText(ctx.page)) === 'Search Down: Zebrafish',
      5000,
      'the prompt to show the edited query',
    );
    for (let i = 0; i < 9; i++) await keys.press('Backspace');
    await keys.type('zebrafish');
    await keys.press('Enter');

    // Down from the bottom wraps to the oldest match, found in history that was not loaded yet.
    await matchOnRow(ctx.page, 'row 300 zebrafish');
    const first = await getCopyModeState(ctx.page);
    // The cursor is on the first cell of the word.
    expect(first.cursorCol).toBe('row 300 '.length);

    await keys.press('n');
    await matchOnRow(ctx.page, 'row 900 zebrafish');
    await keys.press('n');
    await matchOnRow(ctx.page, 'row 1300 zebrafish');
    await keys.press('N');
    await matchOnRow(ctx.page, 'row 900 zebrafish');

    // `?` searches up from the cursor.
    await keys.type('?');
    await waitForCondition(
      ctx.page,
      async () => (await promptText(ctx.page)) === 'Search Up: ',
      5000,
      'the search-up prompt',
    );
    await keys.type('row 1');
    await keys.press('Enter');
    await matchOnRow(ctx.page, 'row 199');

    // A search with no match says so, and the cursor stays.
    const before = await getCopyModeState(ctx.page);
    await keys.type('/');
    await keys.type('no-such-text');
    await keys.press('Enter');
    await waitForCondition(
      ctx.page,
      async () => (await promptText(ctx.page)) === 'Not found: no-such-text',
      5000,
      'the not-found notice',
    );
    const after = await getCopyModeState(ctx.page);
    expect([after.cursorRow, after.cursorCol]).toEqual([before.cursorRow, before.cursorCol]);

    // Escape closes an open prompt and stays in copy mode; the next one leaves.
    await keys.type('/');
    await keys.type('abc');
    await keys.press('Escape');
    await waitForCondition(
      ctx.page,
      async () => (await promptText(ctx.page)) === null,
      5000,
      'the prompt to close',
    );
    expect((await getCopyModeState(ctx.page)).mode).toBe('copy');
    await keys.press('Escape');
    await waitForCopyMode(ctx.page, false);
  }, 180000);
});
