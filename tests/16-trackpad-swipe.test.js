/**
 * A two-finger trackpad slide switches tabs (machines/actors/gestureActor.ts,
 * components/GestureStage.tsx, PaneLayout's swipe neighbour).
 *
 * A trackpad reaches the page as `wheel` events with `deltaX`, which is what
 * the mouse wheel dispatches here. The slide is watched frame by frame: the
 * grid's transform, every pane item's class and position, and every DOM
 * mutation under the pane area, so a jump, a blink or a re-render during the
 * gesture is a failure with a timeline, not a feeling.
 */
const {
  createTestContext,
  delay,
  runCommand,
  waitForCondition,
  createWindowKeyboard,
  prevWindowKeyboard,
} = require('./helpers');
const { writeFileSync } = require('node:fs');

const RECORD_DIR = process.env.TMUXY_SWIPE_RECORD_DIR || null;

const activeWindowId = (page) =>
  page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId ?? null);

/** Start recording frames and mutations under the pane area. */
async function startRecording(page) {
  await page.evaluate(() => {
    const t0 = performance.now();
    const rec = { frames: [], mutations: [], t0 };
    window.__swipeRec = rec;
    const layout = document.querySelector('.pane-layout');
    const container = layout?.parentElement;
    const observer = new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const entry = {
          t: Math.round(performance.now() - t0),
          type: m.type,
          target:
            `${el?.className ?? ''}${el?.dataset?.paneId ? `[${el.dataset.paneId}]` : ''}`.slice(
              0,
              80,
            ),
        };
        if (m.type === 'attributes') {
          entry.attr = m.attributeName;
          if (m.attributeName === 'style') {
            entry.value = `${el.style.transform}|${el.style.transition}`;
          } else {
            entry.value = (el.getAttribute(m.attributeName) ?? '').slice(0, 80);
          }
        } else {
          entry.added = m.addedNodes.length;
          entry.removed = m.removedNodes.length;
        }
        rec.mutations.push(entry);
      }
    });
    observer.observe(container, { subtree: true, attributes: true, childList: true });
    rec.stop = () => observer.disconnect();
    const sample = () => {
      if (!window.__swipeRec) return;
      const items = [...document.querySelectorAll('.pane-layout > .pane-layout-item')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.dataset.paneId,
          cls: el.className.replace('pane-layout-item', '').trim(),
          left: Math.round(r.left),
          width: Math.round(r.width),
          visible: r.width > 0 && getComputedStyle(el).visibility !== 'hidden',
          text: el.querySelector('.terminal-content')?.textContent ?? '',
        };
      });
      rec.frames.push({
        t: Math.round(performance.now() - t0),
        transform: layout.style.transform,
        transition: layout.style.transition,
        live: getComputedStyle(layout).transform,
        items,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopRecording(page) {
  return page.evaluate(() => {
    const rec = window.__swipeRec;
    rec.stop();
    window.__swipeRec = null;
    return { frames: rec.frames, mutations: rec.mutations };
  });
}

/** Two fingers sliding left (content follows: the next tab comes in from the right). */
async function slide(page, x, y, { steps = 14, step = 36, every = 16, direction = 1 } = {}) {
  await page.mouse.move(x, y);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(direction * step, 0);
    await delay(every);
  }
}

describe('Trackpad: a two-finger slide switches tabs', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('the grid follows the fingers, the next tab lands without a jump, and nothing re-renders mid-slide', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await runCommand(ctx.page, 'echo TAB_ONE_MARK', 'TAB_ONE_MARK');
    const first = await activeWindowId(ctx.page);
    await createWindowKeyboard(ctx.page);
    await runCommand(ctx.page, 'echo TAB_TWO_MARK', 'TAB_TWO_MARK');
    const second = await activeWindowId(ctx.page);
    expect(second).not.toBe(first);
    await prevWindowKeyboard(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => (await activeWindowId(ctx.page)) === first,
      8000,
      'the first tab to be back on screen',
    );

    const pane = await ctx.page.evaluate(() => {
      const r = document.querySelector('.pane-layout').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, left: r.left };
    });

    await startRecording(ctx.page);
    await slide(ctx.page, pane.x, pane.y);
    await waitForCondition(
      ctx.page,
      async () => (await activeWindowId(ctx.page)) === second,
      8000,
      'the slide to switch to the second tab',
    );
    // Let the settle animation run out and the grid come to rest.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const g = window.app?.getSnapshot()?.context?.gesture;
          const layout = document.querySelector('.pane-layout');
          return !g && getComputedStyle(layout).transform === 'none';
        }),
      8000,
      'the slide to settle',
    );
    await delay(100);
    const rec = await stopRecording(ctx.page);
    if (RECORD_DIR) {
      writeFileSync(`${RECORD_DIR}/swipe-record.json`, JSON.stringify(rec, null, 1));
    }

    // 1. What is on screen at rest is the second tab, at the grid's origin.
    const restingLeft = rec.frames[0].items.find((i) => i.visible).left;
    const last = rec.frames[rec.frames.length - 1];
    const shown = last.items.filter((i) => i.visible);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((i) => i.text.includes('TAB_TWO_MARK'))).toBe(true);
    expect(shown.every((i) => Math.abs(i.left - restingLeft) <= 1)).toBe(true);

    // 2. Every pane on screen moved continuously: from one frame to the next
    //    no pane's left edge jumps further than a finger step, and none ever
    //    moves back against the slide. The commit swaps which pane is the
    //    grid's and which the neighbour, and puts the grid back by exactly the
    //    offset — the same picture; this is what checks that.
    //    A released slide runs home at the speed the fingers had, so a frame
    //    of the settle covers more than a finger step; a real jump is the
    //    width of a tab.
    expect(paneJumps(rec.frames, 150)).toEqual([]);

    // 3. No pane was hidden or shown mid-slide: the tab coming in is drawn
    //    from the first step to the last, and the tab leaving stays until the
    //    grid has settled.
    expect(hiddenToggles(rec.mutations, rec.frames)).toEqual([]);
  }, 60000);
});

/** Frames where a pane on screen moved more than `step` px, or back against the slide. */
function paneJumps(frames, step) {
  const jumps = [];
  for (let i = 1; i < frames.length; i++) {
    for (const item of frames[i].items) {
      if (!item.visible) continue;
      const before = frames[i - 1].items.find((p) => p.id === item.id);
      if (!before || !before.visible) continue;
      const d = item.left - before.left;
      if (d > 0 || d < -step) {
        jumps.push({ t: frames[i].t, id: item.id, from: before.left, to: item.left });
      }
    }
  }
  return jumps;
}

/** Pane items that went `pane-window-hidden` or came out of it while the grid was still moving. */
function hiddenToggles(mutations, frames) {
  // The grid is settled from the first frame that has it back within a pixel
  // of rest after it had moved.
  const xOf = (f) => {
    const m = f.live.match(/matrix\(([^)]+)\)/);
    return m ? Number(m[1].split(',')[4]) : 0;
  };
  let moved = false;
  let settledAt = frames[frames.length - 1].t;
  for (const f of frames) {
    const x = Math.abs(xOf(f));
    if (x > 1) moved = true;
    else if (moved) {
      settledAt = f.t;
      break;
    }
  }
  return mutations.filter(
    (m) =>
      m.type === 'attributes' &&
      m.attr === 'class' &&
      m.t > frames[0].t + 1 &&
      m.t < settledAt &&
      /pane-window-hidden/.test(m.value),
  );
}
