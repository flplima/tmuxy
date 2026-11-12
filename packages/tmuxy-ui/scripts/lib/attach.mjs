/**
 * Attach time: how long after the page starts loading the session is on
 * screen and takes keys, and what is typed meanwhile. Web only (it reloads
 * the page; the desktop app opens its session once).
 *
 * - `attach-paint`: navigation start to the focused pane showing its prompt.
 * - `attach-interactive`: navigation start to the first key echoed. From the
 *   moment the app exists a token is typed every {@link RETYPE_MS}, until one
 *   shows in the focused pane.
 * - `attach-scroll`: from a first wheel scroll over the focused pane, just
 *   attached, to every row in the view loaded: the history it needs fetched.
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
    if (seen.paint === null && /[$#%>❯]/.test(text)) seen.paint = performance.now();
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

/**
 * A first wheel scroll over the focused pane, just attached: how long until
 * every row in the view is loaded (its scrollback fetched), or null.
 */
async function firstScroll(page) {
  const box = await page.locator('.pane-layout-item.pane-active').first().boundingBox();
  if (!box) return null;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const started = await page.evaluate(() => performance.now());
  await page.mouse.wheel(0, -240);
  const loaded = await page
    .waitForFunction(
      () => {
        const view = window.app.view().copyMode;
        if (!view || view.height === 0) return false;
        const [top, bottom] = [view.scrollTop, view.scrollTop + view.height - 1];
        const ready = view.loadedRanges.some(([from, to]) => from <= top && to >= bottom);
        return ready ? performance.now() : false;
      },
      null,
      { timeout: ATTACH_TIMEOUT_MS },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  return loaded === null ? null : Math.round((loaded - started) * 10) / 10;
}

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
  // The next reload closes the scroll view this opens.
  return { ...seen, scroll: await firstScroll(page) };
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
  const scroll = [];
  let scrollTimeouts = 0;
  let timeouts = 0;
  let typed = 0;
  let lost = 0;
  for (let round = 0; round <= samples; round++) {
    const seen = await attachOnce(page, round);
    if (round === 0) continue;
    if (seen.scroll === null) scrollTimeouts++;
    else scroll.push(seen.scroll);
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
    {
      name: 'attach-scroll',
      samples: scroll.length,
      timeouts: scrollTimeouts,
      values: scroll,
      load: { historyLines: HISTORY_LINES },
    },
  ];
}
