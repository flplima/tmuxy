/**
 * Session & Connectivity E2E Tests (Slow Link)
 *
 * The app behind a proxy that makes every round trip cost what a server on
 * another continent costs.
 */

const {
  describeE2E,
  focusPage,
  waitForTerminalText,
  openSession,
  delay,
  TMUXY_PORT,
} = require('./helpers');
const { waitBudget } = require('./helpers/config');
const { startLatencyProxy } = require('./helpers/latency-proxy');

/** The link's round trip, in ms: a server an ocean away. */
const RTT = 150;
/** A fast typist: faster than the link answers. */
const KEY_INTERVAL_MS = 60;
const LINE = 'thequickbrownfoxjumpsoverthelazydog01234';

/**
 * Type `text` one real keydown at a time, `interval` apart, and resolve to how
 * long after the LAST keydown the whole of `text` was in the active pane, in
 * ms. Both instants are read in the page, so the driver's own round trips are
 * in neither. Throws, with what the pane shows, when the text never appears.
 */
async function typeAndTimeTheEcho(page, text, interval) {
  // Armed and awaited before the first key: a keydown the listener missed
  // would never be counted.
  await page.evaluate(
    ({ text, keys, patience }) => {
      window.__echoOfTheLine = new Promise((resolve) => {
        let seen = 0;
        let lastKeyAt = 0;
        const onKey = () => {
          if (++seen === keys) lastKeyAt = performance.now();
        };
        document.addEventListener('keydown', onKey, { capture: true });
        const pane = () =>
          document.querySelector('.pane-layout-item.pane-active [role="log"]')?.textContent ?? '';
        const finish = (answer) => {
          observer.disconnect();
          clearTimeout(gaveUp);
          document.removeEventListener('keydown', onKey, { capture: true });
          resolve(answer);
        };
        const check = () => {
          if (lastKeyAt && pane().includes(text)) finish({ ms: performance.now() - lastKeyAt });
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        const gaveUp = setTimeout(() => finish({ keydowns: seen, pane: pane() }), patience);
      });
    },
    { text, keys: text.length, patience: waitBudget(30000) },
  );
  // Paced against the clock: a slow driver must not stretch the burst.
  const start = Date.now();
  for (const [i, char] of [...text].entries()) {
    while (Date.now() < start + i * interval) await delay(5);
    await page.keyboard.press(char);
  }
  const answer = await page.evaluate(() => window.__echoOfTheLine);
  if (answer.ms === undefined) {
    throw new Error(
      `"${text}" never showed in the active pane after ${answer.keydowns} of ${text.length} ` +
        `keydowns; it shows: ${JSON.stringify(answer.pane.slice(-200))}`,
    );
  }
  return answer.ms;
}

describeE2E('Scenario 22d: Typing over a slow link', {}, (ctx) => {
  let link;

  beforeAll(async () => {
    link = await startLatencyProxy({ targetPort: TMUXY_PORT, rttMs: RTT });
  }, ctx.hookTimeout);
  afterAll(() => link?.stop());

  test('type a line faster than the link answers → the line is on screen as typed → its last key echoed as fast as a key typed alone', async () => {
    await ctx.setupPage();
    const page = ctx.page;
    await openSession(page, ctx.session.name, link.url);
    await focusPage(page);

    // What one key costs on this link and this machine, typed with nothing in
    // flight: the round trip plus whatever the runner adds. The slowest of
    // three, so the bound below is not set by a lucky one.
    let alone = 0;
    for (const key of ['X', 'Y', 'Z']) {
      alone = Math.max(alone, await typeAndTimeTheEcho(page, key, 0));
    }
    expect(alone).toBeGreaterThanOrEqual(RTT);
    await page.keyboard.press('Control+u');

    // Keys that wait for the answer to the one before leave one round trip
    // apart, however fast they are typed: this line's last key was then
    // (RTT - interval) × 40 = 3.6 s behind. Posted as they are typed, it is
    // behind by what a key typed alone is, and one more round trip is the
    // room given.
    const last = await typeAndTimeTheEcho(page, LINE, KEY_INTERVAL_MS);
    expect(last).toBeLessThanOrEqual(alone + RTT);

    // On screen, readable, and in the order typed: commands that overtook one
    // another on the way would show the letters transposed.
    await waitForTerminalText(page, LINE);
  }, 120000);
});
