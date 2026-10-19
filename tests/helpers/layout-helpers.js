const { typeInTerminal, pressEnter, TMUXY_CLI, waitForCondition } = require('./index');

// ==================== Float Visual Verification Helper ====================

/**
 * Verify a float pane is visually present and interactive.
 * Checks bounding rect, visible content area, and terminal presence.
 * Returns { floatRect, contentRect } for further assertions.
 */
async function verifyFloatVisible(page) {
  const info = await page.evaluate(() => {
    // Find the float container (centered float) or modal-container (drawer)
    const fc =
      document.querySelector('.float-container') || document.querySelector('.modal-container');
    if (!fc) return null;
    const fcRect = fc.getBoundingClientRect();

    // Find the terminal content area inside the float
    const content = fc.querySelector('.float-content') || fc.querySelector('.terminal-content');
    const contentRect = content ? content.getBoundingClientRect() : null;

    // Check for terminal log element
    const log = fc.querySelector('[role="log"]');
    const logRect = log ? log.getBoundingClientRect() : null;

    return {
      floatRect: {
        x: Math.round(fcRect.x),
        y: Math.round(fcRect.y),
        w: Math.round(fcRect.width),
        h: Math.round(fcRect.height),
      },
      contentRect: contentRect
        ? { w: Math.round(contentRect.width), h: Math.round(contentRect.height) }
        : null,
      logRect: logRect ? { w: Math.round(logRect.width), h: Math.round(logRect.height) } : null,
    };
  });

  expect(info).not.toBeNull();
  expect(info.floatRect.w).toBeGreaterThan(100);
  expect(info.floatRect.h).toBeGreaterThan(100);
  expect(info.contentRect).not.toBeNull();
  expect(info.contentRect.w).toBeGreaterThan(50);
  expect(info.contentRect.h).toBeGreaterThan(50);

  return info;
}

async function waitForFloatModal(page, timeout = 10000) {
  await page.waitForSelector('.modal-overlay', { timeout });
}

async function waitForNoModal(page) {
  await page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
    timeout: 10000,
    polling: 100,
  });
}

const focusedFloatPaneId = (page) =>
  page.evaluate(() => window.app?.getSnapshot()?.context?.focusedFloatPaneId ?? null);

/**
 * How far the float's centre sits from the centre of the pane container's
 * content box (the box the grid fills), in pixels, with the container's width
 * so a caller can tell a resize arrived.
 */
const floatCentreOffset = (page) =>
  page.evaluate(() => {
    const float = document.querySelector('.float-modal .modal-container');
    const container = document.querySelector('.pane-container');
    if (!float || !container) return null;
    const f = float.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    const pad = getComputedStyle(container);
    const left = c.x + parseFloat(pad.paddingLeft);
    const right = c.right - parseFloat(pad.paddingRight);
    const top = c.y + parseFloat(pad.paddingTop);
    const bottom = c.bottom - parseFloat(pad.paddingBottom);
    return {
      dx: f.x + f.width / 2 - (left + right) / 2,
      dy: f.y + f.height / 2 - (top + bottom) / 2,
      containerWidth: Math.round(c.width),
    };
  });

/**
 * How far off centre a float may measure. Its position is computed exactly;
 * the browser then snaps each edge to a whole pixel, half a pixel at most, and
 * the rects come back with floating-point noise on top (CI measured
 * 1.0000153).
 */
const CENTRE_TOLERANCE_PX = 1.001;

const isCentred = (offset) =>
  offset !== null &&
  Math.abs(offset.dx) <= CENTRE_TOLERANCE_PX &&
  Math.abs(offset.dy) <= CENTRE_TOLERANCE_PX;

/**
 * Open a float the way a user does — `tmuxy pane float` typed at the prompt —
 * and return once it is on screen with a real size and holds the keyboard
 * focus. Returns the focused float's pane id.
 */
async function openFloatFromCli(ctx) {
  await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
  await pressEnter(ctx.page);
  // Extended timeout for the CLI → run-shell → control mode chain.
  await waitForFloatModal(ctx.page, 20000);
  // float-create.sh's last step focuses the float, which is what the wait
  // below holds out for — not a fixed beat after the modal appears.
  await verifyFloatVisible(ctx.page);
  await waitForCondition(
    ctx.page,
    async () => (await focusedFloatPaneId(ctx.page)) !== null,
    5000,
    'focusedFloatPaneId to be set after float appears',
  );
  return focusedFloatPaneId(ctx.page);
}

// ==================== Scenario 6e: Pinned Terminal Dock ====================

/**
 * Watch a sidebar column and the pane container slide: after `trigger`, sample
 * both widths on every frame from the first frame the column's width changes
 * until `settleMs` after it, and return the series — so a test can assert the
 * column actually eased between its two sizes (several distinct in-between
 * widths, monotonic) and the grid's width moved with it. The trigger is a tmux
 * keybinding round trip, so the first movement can be a while coming; sampling
 * gives up after `timeoutMs` without one.
 */
async function sampleSidebarSlide(
  page,
  trigger,
  columnSelector,
  { settleMs = 400, timeoutMs = 8000 } = {},
) {
  const sampling = page.evaluate(
    ({ sel, settleMs, timeoutMs }) =>
      new Promise((resolve) => {
        const column = [];
        const container = [];
        const start = performance.now();
        let movedAt = null;
        const widthOf = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
        const tick = () => {
          const now = performance.now();
          const w = widthOf(document.querySelector(sel));
          if (movedAt === null && column.length > 0 && w !== column[0]) {
            movedAt = now;
            column.length = 1;
            container.length = 1;
          }
          column.push(w);
          container.push(widthOf(document.querySelector('.pane-container')));
          const done = movedAt === null ? now - start > timeoutMs : now - movedAt > settleMs;
          if (done) resolve({ column, container });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { sel: columnSelector, settleMs, timeoutMs },
  );
  await trigger();
  return sampling;
}

/**
 * Watch the smooth cursor (the one overlay that glides between the panes'
 * cursor anchors) travel: sample the centroid of its smear polygon on every
 * frame after `trigger`, from its first movement until it has been still for
 * `settleMs`, and return the series with where it settled.
 */
async function sampleCursorGlide(page, trigger, { settleMs = 250, timeoutMs = 8000 } = {}) {
  const sampling = page.evaluate(
    ({ settleMs, timeoutMs }) =>
      new Promise((resolve) => {
        const shape = document.querySelector('[data-testid="smooth-cursor"] .smooth-cursor-shape');
        const centroid = () => {
          const pts = [...shape.style.clipPath.matchAll(/([-\d.]+)px ([-\d.]+)px/g)].map((m) => [
            +m[1],
            +m[2],
          ]);
          if (pts.length === 0) return null;
          const sum = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
          return [Math.round(sum[0] / pts.length), Math.round(sum[1] / pts.length)];
        };
        const same = (a, b) => (!a && !b) || (a && b && a[0] === b[0] && a[1] === b[1]);
        const frames = [];
        const start = performance.now();
        let movedAt = null;
        let stillSince = null;
        const tick = () => {
          const now = performance.now();
          const c = centroid();
          if (movedAt === null && frames.length > 0 && !same(c, frames[0])) {
            movedAt = now;
            frames.length = 1;
          }
          if (frames.length > 0 && same(c, frames[frames.length - 1])) {
            if (stillSince === null) stillSince = now;
          } else {
            stillSince = null;
          }
          frames.push(c);
          const done =
            movedAt === null
              ? now - start > timeoutMs
              : stillSince !== null && now - stillSince > settleMs;
          if (done) {
            // What the overlay and its anchor look like at the end, so a run
            // that saw no glide says why (never drawn, hidden, anchor missing).
            const root = document.querySelector('[data-testid="smooth-cursor"]');
            const anchors = [...document.querySelectorAll('.terminal-cursor')].map((el) => {
              const r = el.getBoundingClientRect();
              return `${el.className}@${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
            });
            resolve({
              frames,
              settled: c,
              overlay: {
                opacity: root ? root.style.opacity : 'no overlay',
                clipPath: shape.style.clipPath.slice(0, 120),
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                anchors,
              },
            });
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { settleMs, timeoutMs },
  );
  await trigger();
  return sampling;
}

/** Distinct positions in a glide's frames — the failure message carries the frames and overlay state. */
function glidePositions(glide) {
  return {
    distinct: new Set(glide.frames.map(String)).size,
    frames: glide.frames,
    overlay: glide.overlay,
  };
}

/** Centre of the pane's own cursor anchor (hidden; what the overlay glides to). */
async function cursorAnchorCenter(page, scopeSelector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(`${sel} .terminal-cursor`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  }, scopeSelector);
}

/**
 * Why the series is NOT an eased slide (several distinct widths, never
 * reversing direction), or null when it is — so the failure shows the frames.
 */
function slideProblem(series, direction) {
  const distinct = [...new Set(series)];
  const reversal = series.findIndex(
    (v, i) => i > 0 && (direction > 0 ? v < series[i - 1] : v > series[i - 1]),
  );
  if (distinct.length < 3) return `only ${distinct.length} distinct widths: ${series.join(',')}`;
  if (reversal !== -1) return `reversed at frame ${reversal}: ${series.join(',')}`;
  return null;
}

module.exports = {
  ...require('./index'),
  verifyFloatVisible,
  waitForFloatModal,
  waitForNoModal,
  focusedFloatPaneId,
  floatCentreOffset,
  CENTRE_TOLERANCE_PX,
  isCentred,
  openFloatFromCli,
  sampleSidebarSlide,
  sampleCursorGlide,
  glidePositions,
  cursorAnchorCenter,
  slideProblem,
};
