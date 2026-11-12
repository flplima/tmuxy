/**
 * Attach time: how long after the page starts loading the session is on
 * screen and takes keys, and what is typed meanwhile. Web only (it reloads
 * the page; the desktop app opens its session once).
 *
 * - `attach-paint`: navigation start to the focused pane showing its text.
 * - `attach-interactive`: navigation start to the first key echoed. From the
 *   moment the app exists a token is typed every {@link RETYPE_MS}, until one
 *   shows in the focused pane.
 * - `lostKeys` on `attach-interactive`: the tokens typed that never showed,
 *   summed over the samples. A key typed during the attach should arrive,
 *   late if it must, and in order; every token lost is one dropped.
 *
 * The focused pane is first given {@link HISTORY_LINES} lines of scrollback,
 * so an attach that fetched history would pay for it here. Times are the
 * page's own clock (`performance.now()` from navigation start), read by a
 * script installed before the page's own runs.
 */

/** The scrollback the focused pane holds while attach is measured. */
export const HISTORY_LINES = 10000;

/** A sample slower than this is a timeout. */
const ATTACH_TIMEOUT_MS = 15000;

/** How often a token is typed again while none has shown. */
const RETYPE_MS = 100;

/** Installed before the page's scripts: when the prompt and a token showed. */
function attachProbe() {
  const seen = { paint: null, echo: null, typed: [] };
  window.__attach = seen;
  const shown = () =>
    document.querySelector('.pane-layout-item.pane-active [role="log"]')?.textContent ?? '';
  window.__attachShown = (tokens) => tokens.filter((t) => shown().includes(t));
  const check = () => {
    const text = shown();
    // Painted: the pane shows anything at all, whatever its prompt looks like.
    if (seen.paint === null && text.trim().length > 0) seen.paint = performance.now();
    if (seen.echo === null && seen.typed.some((t) => text.includes(t))) {
      seen.echo = performance.now();
    }
  };
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

/** A token no prompt holds: letters only, so any layout types it. */
const tokenFor = (round, attempt) =>
  `zq${'abcdefghij'[round % 10]}${'klmnopqrst'[attempt % 10]}${'uvwy'[Math.floor(attempt / 10) % 4]}x`;

/** One reload: its paint and first echo, and how many tokens it lost. */
async function attachOnce(page, round) {
  await page.reload({ waitUntil: 'commit' });
  await page.waitForFunction(() => !!window.app, null, { timeout: ATTACH_TIMEOUT_MS });
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < ATTACH_TIMEOUT_MS) {
    if (await page.evaluate(() => window.__attach.echo !== null)) break;
    const token = tokenFor(round, attempt++);
    await page.evaluate((t) => window.__attach.typed.push(t), token);
    await page.keyboard.type(token);
    await page.waitForTimeout(RETYPE_MS);
  }
  // Late arrivals count as arrived: give queued keys their chance.
  await page.waitForTimeout(1000);
  const seen = await page.evaluate(() => ({
    ...window.__attach,
    shown: window.__attachShown(window.__attach.typed),
  }));
  // The tokens go, so the next sample starts from a prompt.
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(300);
  return seen;
}

/**
 * Reload `page` `samples` times (after one discarded warm-up) and return
 * `attach-paint` and `attach-interactive`.
 */
export async function measureAttach(page, { samples, prepare }) {
  await page.addInitScript(attachProbe);
  if (prepare) await prepare();
  const paint = [];
  const interactive = [];
  let timeouts = 0;
  let typed = 0;
  let lost = 0;
  for (let round = 0; round <= samples; round++) {
    const seen = await attachOnce(page, round);
    if (round === 0) continue;
    if (seen.paint === null || seen.echo === null) {
      timeouts++;
      continue;
    }
    paint.push(Math.round(seen.paint * 10) / 10);
    interactive.push(Math.round(seen.echo * 10) / 10);
    typed += seen.typed.length;
    lost += seen.typed.length - seen.shown.length;
  }
  return [
    { name: 'attach-paint', samples: paint.length, timeouts, values: paint },
    {
      name: 'attach-interactive',
      samples: interactive.length,
      timeouts,
      values: interactive,
      load: { historyLines: HISTORY_LINES, typedKeys: typed, lostKeys: lost },
    },
  ];
}
