/**
 * Pane Animation E2E Tests
 *
 * Split runs the enter morph: the new pane appears at the source pane's
 * pre-split box at reduced opacity and converges to its final half-box while
 * fading in (`.pane-entering`), the source pane shifting on the same clock
 * (`.pane-shifting`). Killing a pane is the reverse: the dying pane keeps its
 * node mounted with `.pane-leaving`, morphing into the survivor's expanded
 * box while fading out, then the node is removed.
 *
 * Verified through real user paths (prefix-key split, typing `exit`) with an
 * in-page rAF sampler + `transitionstart` listener, asserting on bounding
 * rects over time — not just end-state DOM.
 */

const {
  createTestContext,
  delay,
  waitForPaneCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  splitPaneKeyboard,
  createWindowKeyboard,
  nextWindowKeyboard,
  waitForWindowCount,
  waitForCondition,
  DELAYS,
} = require('./helpers');

/**
 * Install an in-page recorder that rAF-samples any `.pane-entering` /
 * `.pane-leaving` node (rect + opacity) and records which CSS properties
 * actually started transitioning on them.
 */
async function installAnimationRecorder(page) {
  await page.evaluate(() => {
    const layout = document.querySelector('.pane-layout');
    const rec = {
      enterSeen: false,
      enterPaneId: null,
      enterSamples: [],
      enterTransitionProps: [],
      leaveSeen: false,
      leavePaneId: null,
      leaveGone: false,
      leaveTransitionProps: [],
      lifecycleSightings: 0,
    };
    window.__animRec = rec;
    window.__animRecStop = false;

    const onTransitionStart = (e) => {
      const t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('pane-entering')) rec.enterTransitionProps.push(e.propertyName);
      if (t.classList.contains('pane-leaving')) rec.leaveTransitionProps.push(e.propertyName);
    };
    layout.addEventListener('transitionstart', onTransitionStart);

    const tick = () => {
      const entering = layout.querySelector('.pane-layout-item.pane-entering');
      if (entering) {
        rec.enterSeen = true;
        rec.enterPaneId = entering.getAttribute('data-pane-id');
        const r = entering.getBoundingClientRect();
        rec.enterSamples.push({
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          opacity: parseFloat(getComputedStyle(entering).opacity),
        });
      }
      const leaving = layout.querySelector('.pane-layout-item.pane-leaving');
      if (leaving) {
        rec.leaveSeen = true;
        rec.leavePaneId = leaving.getAttribute('data-pane-id');
      } else if (rec.leaveSeen) {
        rec.leaveGone = true;
      }
      if (entering || leaving || layout.querySelector('.pane-shifting')) {
        rec.lifecycleSightings++;
      }
      if (!window.__animRecStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readAnimationRecorder(page) {
  return page.evaluate(() => window.__animRec);
}

async function stopAnimationRecorder(page) {
  await page.evaluate(() => {
    window.__animRecStop = true;
  });
}

function getVisiblePaneRects(page) {
  return page.evaluate(() => {
    const items = document.querySelectorAll(
      '.pane-layout-item[data-pane-id]:not(.pane-window-hidden):not(.pane-leaving)',
    );
    return Array.from(items).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-pane-id'),
        active: el.classList.contains('pane-active'),
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      };
    });
  });
}

function countLifecycleClasses(page) {
  return page.evaluate(
    () => document.querySelectorAll('.pane-entering, .pane-leaving, .pane-shifting').length,
  );
}

/**
 * The app re-enables layout animations only after two quiet model updates
 * (appMachine settle path) — a freshly-connected idle session produces none,
 * so generate some terminal traffic first, then wait for the gate to drop.
 */
async function waitForAnimationsEnabled(page) {
  await typeInTerminal(page, 'echo anim warmup');
  await pressEnter(page);
  await waitForTerminalText(page, 'anim warmup');
  await waitForCondition(
    page,
    () =>
      page.evaluate(
        () => !document.querySelector('.pane-layout')?.classList.contains('pane-layout-no-animations'),
      ),
    10000,
    'layout animations enabled',
  );
}

describe('Pane split/kill animations', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Split morphs new pane out of the source box; exit morphs it back into the survivor', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await waitForPaneCount(ctx.page, 1);
    await waitForAnimationsEnabled(ctx.page);

    const [sourceRect] = await getVisiblePaneRects(ctx.page);
    expect(sourceRect.width).toBeGreaterThan(100);

    // ---- Split (real user path: prefix + ") ----
    await installAnimationRecorder(ctx.page);
    await splitPaneKeyboard(ctx.page);
    expect(await waitForPaneCount(ctx.page, 2, 8000)).toBe(true);

    // Let the morph finish, then read what the sampler saw.
    await waitForCondition(
      ctx.page,
      async () => (await countLifecycleClasses(ctx.page)) === 0,
      5000,
      'enter animation settled',
    );
    const splitRec = await readAnimationRecorder(ctx.page);

    // The enter animation ran, with opacity in every case.
    expect(splitRec.enterSeen).toBe(true);
    expect(splitRec.enterTransitionProps).toContain('opacity');

    const finals = await getVisiblePaneRects(ctx.page);
    expect(finals.length).toBe(2);
    const maxFinalArea = Math.max(...finals.map((r) => r.width * r.height));
    const first = splitRec.enterSamples[0];
    const last = splitRec.enterSamples[splitRec.enterSamples.length - 1];
    expect(first.opacity).toBeLessThan(1);

    // Two DESIGNED outcomes (PaneLayout's enter path):
    //  - Morph: findEnterFromBox found the source pane's pre-split box (the
    //    source shrank in the SAME state update the new pane arrived in) and
    //    the pane FLIPs from it — geometry transitions run, and the first
    //    sample is ≈ the source's double-size box converging to the half box.
    //  - Fade in place: the split landed as TWO updates (source shrink first,
    //    new pane after — common under CI load, where tmux's layout-change
    //    and list-panes events don't coalesce), so nothing "plausibly shrank"
    //    in the pane's birth update and the code's documented fallback fades
    //    the pane at its final geometry. Asserting the morph unconditionally
    //    made this designed fallback a test failure on loaded runners.
    const geometryMorphRan =
      splitRec.enterTransitionProps.includes('width') ||
      splitRec.enterTransitionProps.includes('left');
    if (geometryMorphRan) {
      // Morph path: started (≈) at the source's pre-split box — roughly
      // double the final half-box area — and converged (direction-agnostic).
      expect(first.width * first.height).toBeGreaterThan(maxFinalArea * 1.5);
      expect(last.width * last.height).toBeLessThan(first.width * first.height);
    } else {
      // Fade-in-place path: the pane must already sit at (≈) its final
      // half-box — never a flash at some third geometry.
      expect(first.width * first.height).toBeLessThanOrEqual(maxFinalArea * 1.1);
      expect(last.width * last.height).toBeLessThanOrEqual(maxFinalArea * 1.1);
    }

    // End state: two panes visibly tiled (mosaic panes share only their 1px
    // outline edge), the new pane is active and takes typing.
    const [a, b] = finals;
    const ovX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const ovY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    expect(Math.min(ovX, ovY)).toBeLessThanOrEqual(1);

    const newPane = finals.find((r) => r.id !== sourceRect.id) ?? finals[1];
    expect(finals.find((r) => r.active)?.id).toBe(newPane.id);
    await typeInTerminal(ctx.page, 'echo SPLIT_ANIM_OK');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'SPLIT_ANIM_OK');

    // ---- Kill (real user path: typing `exit` in the new pane) ----
    await typeInTerminal(ctx.page, 'exit');
    await pressEnter(ctx.page);
    expect(await waitForPaneCount(ctx.page, 1, 8000)).toBe(true);

    await waitForCondition(
      ctx.page,
      async () => {
        const rec = await readAnimationRecorder(ctx.page);
        return rec.leaveGone && (await countLifecycleClasses(ctx.page)) === 0;
      },
      5000,
      'leave animation settled',
    );
    const killRec = await readAnimationRecorder(ctx.page);
    await stopAnimationRecorder(ctx.page);

    // The dying pane's node outlived the model drop as .pane-leaving, faded
    // out, and was removed.
    expect(killRec.leaveSeen).toBe(true);
    expect(killRec.leavePaneId).toBe(newPane.id);
    expect(killRec.leaveTransitionProps).toContain('opacity');

    // Survivor reclaimed (≈) the full original box and still takes input.
    const [survivor] = await getVisiblePaneRects(ctx.page);
    const survivorArea = survivor.width * survivor.height;
    const sourceArea = sourceRect.width * sourceRect.height;
    expect(survivorArea).toBeGreaterThan(sourceArea * 0.98);
    expect(survivorArea).toBeLessThan(sourceArea * 1.02);
    await typeInTerminal(ctx.page, 'echo KILL_ANIM_OK');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'KILL_ANIM_OK');
  }, 60000);

  test('No spurious animations: rapid split/exit spam settles clean and tab switches stay class-free', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await waitForPaneCount(ctx.page, 1);
    await waitForAnimationsEnabled(ctx.page);

    // Rapid split bursts followed by rapid exits must end clean: correct
    // pane count, no stuck lifecycle classes, survivor back at full size.
    // (Run this phase first — waitForPaneCount counts hidden-window pane
    // nodes too, so it is only unambiguous while there's a single window.)
    const [beforeRect] = await getVisiblePaneRects(ctx.page);
    for (let i = 0; i < 3; i++) {
      await splitPaneKeyboard(ctx.page);
      // Pace on pane count, not sleeps — each split lands mid-animation of
      // the previous one's confirm traffic.
      expect(await waitForPaneCount(ctx.page, i + 2, 10000)).toBe(true);
    }

    for (let i = 4; i > 1; i--) {
      await typeInTerminal(ctx.page, 'exit');
      await pressEnter(ctx.page);
      expect(await waitForPaneCount(ctx.page, i - 1, 8000)).toBe(true);
    }

    await waitForCondition(
      ctx.page,
      async () => (await countLifecycleClasses(ctx.page)) === 0,
      5000,
      'all lifecycle classes cleared',
    );
    const [finalRect] = await getVisiblePaneRects(ctx.page);
    const finalArea = finalRect.width * finalRect.height;
    const beforeArea = beforeRect.width * beforeRect.height;
    expect(finalArea).toBeGreaterThan(beforeArea * 0.98);
    expect(finalArea).toBeLessThan(beforeArea * 1.02);

    // Tab create + switch must not run pane enter/leave morphs (wholesale
    // window swaps are guarded out of the lifecycle).
    await installAnimationRecorder(ctx.page);
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await nextWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    const tabRec = await readAnimationRecorder(ctx.page);
    await stopAnimationRecorder(ctx.page);
    expect(tabRec.lifecycleSightings).toBe(0);
  }, 90000);
});
