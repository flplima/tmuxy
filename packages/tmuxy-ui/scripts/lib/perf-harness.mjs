/**
 * Shared interaction-latency harness.
 *
 * The *what* of the Axis-C measurement — which interactions are timed, what
 * observable stops each clock, how a run is summarized into a report — lives
 * here once. The *how* of driving a UI lives in a driver adapter, because the
 * web app is driven by Playwright over CDP and the desktop app by WebdriverIO
 * over tauri-driver, and those two have irreconcilable APIs.
 *
 * Keeping the interaction list in one place is the point: a budget in
 * `compare-interactions.mjs` then means the same thing on both surfaces, and a
 * regression that only shows up on the desktop transport (Tauri IPC instead of
 * POST + SSE) lands in the same table as a web one.
 *
 * ## The driver adapter contract
 *
 * An adapter is an object with these methods. Everything here is written
 * against it and nothing else:
 *
 * | method | contract |
 * | --- | --- |
 * | `evaluate(fn, arg)` | run `fn(arg)` in the page, resolve to its (JSON-safe) return value |
 * | `install(fn)` | run `fn()` in the page for its side effects; no return value |
 * | `press(key)` | press one key, Playwright spelling (`'a'`, `'Control+ArrowRight'`) |
 * | `type(text)` | type a literal string, `\n` meaning Enter |
 * | `wait(ms)` | sleep |
 * | `clickActivePane()` | put keyboard focus in the ACTIVE pane's terminal |
 * | `arm(probe, arg, timeoutMs)` | start a measurement, resolve to `{ settle() }` |
 *
 * `arm` is split from its result because the two drivers differ exactly there:
 * Playwright can hold a pending in-page promise across a keystroke, while
 * WebKitWebDriver's sync `execute` cannot, and has to stash the result on
 * `window` and be polled for it. Both keep the actual timing in-page, so the
 * number never includes driver round-trip cost.
 */
import { execSync } from 'node:child_process';

/**
 * A sample slower than this is recorded as a timeout, not a datapoint — a
 * stuck interaction must not masquerade as a slow one.
 */
export const SAMPLE_TIMEOUT_MS = 5000;

/**
 * Quiet gap between samples, so one interaction's trailing state updates never
 * land inside the next one's measurement window.
 */
export const SETTLE_MS = 450;

/** A distinct letter per sample, so a probe counts THIS keystroke's echo. */
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export const pct = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];

export const round1 = (n) => Math.round(n * 10) / 10;

export const shortSha = () => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

// ==================== In-page instrumentation ====================

/**
 * Installed into the page by {@link installProbes}. Must be self-contained:
 * both drivers ship it across by stringifying the function, so it closes over
 * nothing from this module.
 */
function probeInstaller() {
  const activeLog = () => document.querySelector('.pane-layout-item.pane-active [role="log"]');

  // Both selectors are deliberately narrow: `data-pane-id` also lands on the
  // terminal inside each pane, on floats, and on sidebar-tree rows, and
  // `role="tab"` is used by pane-group headers as well as the tab strip.
  // Counting either loosely double-counts a single pane or window.
  window.__perfProbes = {
    activePane: () =>
      document.querySelector('.pane-layout-item.pane-active')?.getAttribute('data-pane-id') ?? '',
    paneCount: () => document.querySelectorAll('.pane-layout-item[data-pane-id]').length,
    zoomed: () => document.querySelectorAll('.pane-zoomed').length,
    activeTab: () =>
      document
        .querySelector('.tab-list [role="tab"][aria-selected="true"]')
        ?.getAttribute('aria-label') ?? '',
    // Occurrences of a specific character in the focused pane, so an
    // unrelated repaint (a clock, a spinner) cannot resolve the sample.
    charCount: (ch) => (activeLog()?.textContent ?? '').split(ch).length - 1,
  };

  window.__perfArm = (probeName, arg, timeoutMs) =>
    new Promise((resolve) => {
      const probe = window.__perfProbes[probeName];
      const base = probe(arg);
      let t0 = 0;
      let settled = false;

      const onKey = () => {
        if (!t0) t0 = performance.now();
      };
      document.addEventListener('keydown', onKey, { capture: true });

      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(deadline);
        document.removeEventListener('keydown', onKey, { capture: true });
        resolve(value);
      };

      const check = () => {
        if (!t0) return; // a mutation before the keydown is not ours
        if (probe(arg) !== base) finish(performance.now() - t0);
      };

      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      // The observer catches the common case; the poll covers a change that
      // lands as a property/style update the observer is not watching.
      const poll = setInterval(check, 8);
      const deadline = setTimeout(() => finish(-1), timeoutMs);
    });

  // The polling entry point, for a driver that cannot hold a pending in-page
  // promise across a keystroke (WebKitWebDriver's sync `execute`). Timing still
  // happens in `__perfArm`; this only parks the answer somewhere readable.
  //
  // `null` while pending, never `undefined`: WebDriver serializes `undefined`
  // to `null` on the way out, so an unset slot and a settled one would be
  // indistinguishable to a polling reader.
  window.__perfArmStart = (probeName, arg, timeoutMs) => {
    window.__perfResult = null;
    window.__perfArm(probeName, arg, timeoutMs).then((v) => {
      window.__perfResult = v;
    });
  };
}

/** Install the probes and the armer into the page under test. */
export async function installProbes(adapter) {
  await adapter.install(probeInstaller);
}

// ==================== Measuring ====================

/**
 * Run one interaction `samples` times.
 *
 * `act` performs the keystroke that starts the clock; `probe`/`probeArg` name
 * the observable that stops it. `between` runs untimed after each sample to
 * put the session back where the next sample expects it.
 */
export async function measure(adapter, { name, samples, act, probe, probeArg = null, between }) {
  const values = [];
  let timeouts = 0;

  // One discarded warm-up: the first sample of an interaction pays for a cold
  // binding lookup and whatever the previous interaction left settling, and it
  // is the sample most likely to race the armer. Measuring it would put a
  // one-off cost into every p95.
  for (let round = 0; round <= samples; round++) {
    const warmup = round === 0;
    const arg = typeof probeArg === 'function' ? probeArg(round) : probeArg;
    const armed = await adapter.arm(probe, arg, SAMPLE_TIMEOUT_MS);
    await adapter.wait(40); // let the listener attach before the key
    await act(round);
    const ms = await armed.settle();
    if (!warmup) {
      if (ms > 0) values.push(ms);
      else timeouts++;
    }
    await adapter.wait(SETTLE_MS);
    if (between) await between(round);
    await adapter.wait(SETTLE_MS);
  }

  return { name, samples: values.length, timeouts, values };
}

export function summarize(result) {
  const sorted = [...result.values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      name: result.name,
      samples: 0,
      timeouts: result.timeouts,
      p50: null,
      p95: null,
      max: null,
    };
  }
  return {
    name: result.name,
    samples: sorted.length,
    timeouts: result.timeouts,
    p50: round1(pct(sorted, 0.5)),
    p95: round1(pct(sorted, 0.95)),
    max: round1(sorted[sorted.length - 1]),
  };
}

// ==================== Session shaping ====================

/** The configured prefix key, as a Playwright-style modifier + key. */
export async function readPrefix(adapter) {
  const raw = await adapter.evaluate(
    () => window.app?.getSnapshot?.()?.context?.keybindings?.prefix_key ?? null,
  );
  if (typeof raw === 'string' && raw.startsWith('C-')) {
    return { modifier: 'Control', key: raw.slice(2) };
  }
  return { modifier: 'Control', key: 'b' };
}

/** Send `prefix` then `key`, as a user does. */
export async function prefixKey(adapter, prefix, key) {
  await adapter.press(`${prefix.modifier}+${prefix.key}`);
  await adapter.wait(60);
  await adapter.press(key);
}

export const paneCount = (adapter) =>
  adapter.evaluate(() => document.querySelectorAll('.pane-layout-item[data-pane-id]').length);

export const tabCount = (adapter) =>
  adapter.evaluate(() => document.querySelectorAll('.tab-list [role="tab"]').length);

/** Grow/shrink the session to exactly `want` panes, through the real bindings. */
export async function ensurePanes(adapter, prefix, want) {
  for (let guard = 0; guard < 8 && (await paneCount(adapter)) < want; guard++) {
    await prefixKey(adapter, prefix, '|');
    await adapter.wait(1200);
  }
  for (let guard = 0; guard < 8 && (await paneCount(adapter)) > want; guard++) {
    await adapter.type('exit\n');
    await adapter.wait(1200);
  }
  // Loudly, rather than measuring whatever is there. An interaction that needs
  // two panes and gets one does not fail — it times out on every sample and
  // then reports a flattering p50 from the one that slipped through, which is
  // a far more expensive thing to debug than a clear message here.
  const got = await paneCount(adapter);
  if (got !== want) {
    throw new Error(
      `could not shape the session to ${want} panes (still ${got}) — ` +
        `the split binding may not be reaching the app on this target`,
    );
  }
}

export async function ensureTabs(adapter, prefix, want) {
  for (let guard = 0; guard < 4 && (await tabCount(adapter)) < want; guard++) {
    await prefixKey(adapter, prefix, 'c');
    await adapter.wait(1500);
  }
  const got = await tabCount(adapter);
  if (got < want) {
    throw new Error(
      `could not shape the session to ${want} tabs (still ${got}) — ` +
        `the new-tab binding may not be reaching the app on this target`,
    );
  }
}

/** Wait until the UI is connected, a prompt has rendered and bindings arrived. */
export async function waitForReady(adapter, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  const poll = async (fn, what) => {
    while (Date.now() < deadline) {
      if (await adapter.evaluate(fn)) return;
      await adapter.wait(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  await poll(() => {
    const text = [...document.querySelectorAll('[role="log"]')]
      .map((l) => l.textContent || '')
      .join('');
    // A prompt, not a length: a fresh session's prompt can be as short as
    // `~❯ `, and a byte-count threshold rejects it as "not ready yet".
    return (
      /[$#%>❯]/.test(text) &&
      text.trim().length > 0 &&
      !!window.app?.getSnapshot?.()?.context?.connected
    );
  }, 'a connected session with a prompt');

  // Keybindings arrive on their own event; a prefix-bound key pressed before
  // they land is silently dropped by the keyboard actor.
  await poll(
    () => (window.app?.getSnapshot?.()?.context?.keybindings?.prefix_bindings ?? []).length > 0,
    'keybindings',
  );
  await adapter.wait(1500);
}

// ==================== The interaction suite ====================

/**
 * Drive every measured interaction once, in order, and return raw results.
 *
 * The order matters and is not arbitrary: `key-echo` runs first because every
 * other number is divided by it, and each interaction leaves the session in
 * the shape the next one expects.
 */
export async function runInteractions(adapter, { samples }) {
  await installProbes(adapter);

  const prefix = await readPrefix(adapter);
  // The ACTIVE pane, never simply the first one in the DOM. Panes of inactive
  // windows stay in the tree with `display: none`, so `.first()` selects a
  // 0x0 element as soon as the session has more than one tab — and this suite
  // creates a second tab itself, for `tab-switch`. Clicking a hidden pane
  // times out and takes the whole run with it.
  await adapter.clickActivePane();
  await adapter.press('Control+u');
  await adapter.wait(500);

  const results = [];

  // --- keystroke echo: the reference every other number is divided by ---
  results.push(
    await measure(adapter, {
      name: 'key-echo',
      samples,
      probe: 'charCount',
      probeArg: (i) => LETTERS[i % 26],
      act: (i) => adapter.press(LETTERS[i % 26]),
    }),
  );
  await adapter.press('Control+u');
  await adapter.wait(500);

  // --- pane navigation: the interaction this harness exists for ---
  await ensurePanes(adapter, prefix, 2);
  results.push(
    await measure(adapter, {
      name: 'pane-nav-keyboard',
      samples,
      probe: 'activePane',
      act: (i) => adapter.press(i % 2 === 0 ? 'Control+ArrowRight' : 'Control+ArrowLeft'),
    }),
  );

  // --- zoom toggle ---
  results.push(
    await measure(adapter, {
      name: 'pane-zoom-toggle',
      samples,
      probe: 'zoomed',
      act: () => prefixKey(adapter, prefix, 'z'),
    }),
  );
  // Leave zoom off however the last sample landed.
  if ((await adapter.evaluate(() => document.querySelectorAll('.pane-zoomed').length)) > 0) {
    await prefixKey(adapter, prefix, 'z');
    await adapter.wait(600);
  }

  // --- split: timed create, untimed teardown back to two panes ---
  results.push(
    await measure(adapter, {
      name: 'pane-split',
      samples,
      probe: 'paneCount',
      act: () => prefixKey(adapter, prefix, '|'),
      between: async () => {
        await adapter.type('exit\n');
        await adapter.wait(900);
      },
    }),
  );
  await ensurePanes(adapter, prefix, 2);

  // --- tab switch ---
  await ensureTabs(adapter, prefix, 2);
  results.push(
    await measure(adapter, {
      name: 'tab-switch',
      samples,
      probe: 'activeTab',
      act: () => adapter.press('Control+Tab'),
    }),
  );

  return results;
}

/**
 * Shape raw results into the report `compare-interactions.mjs` reads.
 *
 * `platform` is passed in rather than derived, because the desktop harness
 * measures a different product on the same machine and must not be compared
 * against the web baseline.
 */
export function buildReport({ results, label, platform, target, url, samplesRequested }) {
  const summaries = results.map(summarize);
  const reference = summaries.find((s) => s.name === 'key-echo');
  const refP50 = reference && reference.p50 ? reference.p50 : null;

  return {
    schema: 1,
    label,
    generatedAt: new Date().toISOString(),
    commit: shortSha(),
    platform,
    target,
    url,
    samplesRequested,
    // Every interaction as a multiple of the keystroke round trip measured on
    // this same machine in this same run. Machine-speed-independent, which is
    // what makes a CI budget possible at all.
    reference: 'key-echo',
    interactions: summaries.map((s) => ({
      ...s,
      ratioToReference: refP50 && s.p50 ? round1(s.p50 / refP50) : null,
    })),
  };
}
