/**
 * Layout Invariant Assertions
 *
 * Verifies visual correctness of the pane mosaic after every layout mutation.
 * Replaces the old assertSpacing helper with comprehensive checks:
 *
 * 1. No overlap between pane-layout-items
 * 2. Pane mosaic is centered in the container
 * 3. No pane overflows the container
 * 4. Container padding is respected
 * 5. Pane headers are not obscured by adjacent panes
 * 6. Rendered dimensions match XState context
 * 7. Exactly one pane has .pane-active
 * 8. Inter-pane gaps match expected charWidth/charHeight
 */

const { delay } = require('./browser');

/**
 * Assert all layout invariants hold for the current pane mosaic.
 *
 * @param {Page} page - Playwright page
 * @param {object} [options]
 * @param {boolean} [options.checkCentering=true] - Check centering (skip during resize)
 * @param {boolean} [options.checkGaps=true] - Check inter-pane gaps
 * @param {string} [options.label] - Label for error messages
 */
async function assertLayoutInvariants(page, options = {}) {
  const { checkCentering = true, checkGaps = true, label } = options;
  const prefix = label ? `[${label}] ` : '';

  // Wait for layout animations to settle
  await delay(500);

  const result = await page.evaluate(({ checkCentering: cc, checkGaps: cg }) => {
    const errs = [];
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return { errors: [], skipped: true };
    const { charWidth, charHeight, panes, activeWindowId, activePaneId } = snap.context;

    const container = document.querySelector('.pane-container');
    if (!container) return { errors: ['No .pane-container found'], skipped: false };
    const cRect = container.getBoundingClientRect();

    // Collect visible pane-layout-items for the active window
    const activePaneIds = new Set(
      (panes || []).filter(p => p.windowId === activeWindowId).map(p => p.tmuxId)
    );
    const allItems = Array.from(document.querySelectorAll('.pane-layout-item[data-pane-id]'))
      .filter(el => activePaneIds.has(el.getAttribute('data-pane-id')));

    // Filter out items that are clearly offscreen (layout transitioning)
    const items = [];
    const rects = [];
    const ids = [];
    for (const el of allItems) {
      const r = el.getBoundingClientRect();
      const overflowLeft = cRect.left - r.left;
      const overflowRight = r.right - cRect.right;
      const overflowTop = cRect.top - r.top;
      const overflowBottom = r.bottom - cRect.bottom;
      const maxOverflow = Math.max(overflowLeft, overflowRight, overflowTop, overflowBottom);
      if (maxOverflow < 50) {
        items.push(el);
        rects.push(r);
        ids.push(el.getAttribute('data-pane-id'));
      }
    }

    if (rects.length === 0) return { errors: [], skipped: true };

    // Check if the pane grid fits within the container.
    // When totalWidth*charWidth > containerWidth, the grid overflows and
    // centering/padding/overflow checks are meaningless (server hasn't resized yet).
    const gridFits = snap.context.totalWidth * charWidth <= cRect.width &&
                     snap.context.totalHeight * charHeight <= cRect.height;

    // ========== 1. No overlap between pane-layout-items ==========
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1) {
          errs.push(
            `Overlap: pane ${ids[i]} and ${ids[j]} overlap by ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}px`
          );
        }
      }
    }

    // ========== 2. Centering ==========
    // Skip centering, overflow, and padding checks when the grid doesn't fit
    // (tmux hasn't been resized to match browser container yet)
    if (cc && gridFits && rects.length > 0) {
      let minLeft = Infinity, maxRight = -Infinity;
      let minTop = Infinity, maxBottom = -Infinity;
      for (const r of rects) {
        minLeft = Math.min(minLeft, r.left);
        maxRight = Math.max(maxRight, r.right);
        minTop = Math.min(minTop, r.top);
        maxBottom = Math.max(maxBottom, r.bottom);
      }
      const leftMargin = minLeft - cRect.left;
      const rightMargin = cRect.right - maxRight;
      const topMargin = minTop - cRect.top;
      const bottomMargin = cRect.bottom - maxBottom;

      // Horizontal centering: margins should differ by less than 1 charWidth
      if (Math.abs(leftMargin - rightMargin) > charWidth) {
        errs.push(
          `Not centered horizontally: leftMargin=${leftMargin.toFixed(1)}px, rightMargin=${rightMargin.toFixed(1)}px (diff=${Math.abs(leftMargin - rightMargin).toFixed(1)}px, threshold=${charWidth.toFixed(1)}px)`
        );
      }
      // Vertical centering
      if (Math.abs(topMargin - bottomMargin) > charHeight) {
        errs.push(
          `Not centered vertically: topMargin=${topMargin.toFixed(1)}px, bottomMargin=${bottomMargin.toFixed(1)}px (diff=${Math.abs(topMargin - bottomMargin).toFixed(1)}px, threshold=${charHeight.toFixed(1)}px)`
        );
      }
    }

    // ========== 3. No overflow ==========
    if (gridFits) for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.left < cRect.left - 2) {
        errs.push(`Overflow: pane ${ids[i]} left edge (${r.left.toFixed(1)}px) is outside container (${cRect.left.toFixed(1)}px)`);
      }
      if (r.right > cRect.right + 2) {
        errs.push(`Overflow: pane ${ids[i]} right edge (${r.right.toFixed(1)}px) is outside container (${cRect.right.toFixed(1)}px)`);
      }
      if (r.top < cRect.top - 2) {
        errs.push(`Overflow: pane ${ids[i]} top edge (${r.top.toFixed(1)}px) is outside container (${cRect.top.toFixed(1)}px)`);
      }
      if (r.bottom > cRect.bottom + 2) {
        errs.push(`Overflow: pane ${ids[i]} bottom edge (${r.bottom.toFixed(1)}px) is outside container (${cRect.bottom.toFixed(1)}px)`);
      }
    }

    // ========== 4. Container padding ==========
    const EXPECTED_PADDING = 8; // CONTAINER_PADDING from layout.ts
    const MIN_PADDING = EXPECTED_PADDING - 2;
    if (gridFits) for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const gaps = {
        left: r.left - cRect.left,
        right: cRect.right - r.right,
        top: r.top - cRect.top,
        bottom: cRect.bottom - r.bottom,
      };
      for (const [side, gap] of Object.entries(gaps)) {
        if (gap < MIN_PADDING) {
          errs.push(
            `Padding: pane ${ids[i]} ${side} gap to container: ${gap.toFixed(1)}px (expected >= ${MIN_PADDING}px)`
          );
        }
      }
    }

    // ========== 5. Header not obscured ==========
    // For each pane, its .pane-header must not be overlapped by any other pane-layout-item
    for (let i = 0; i < items.length; i++) {
      const header = items[i].querySelector('.pane-header');
      if (!header) continue;
      const hRect = header.getBoundingClientRect();
      for (let j = 0; j < rects.length; j++) {
        if (i === j) continue;
        const other = rects[j];
        const overlapX = Math.min(hRect.right, other.right) - Math.max(hRect.left, other.left);
        const overlapY = Math.min(hRect.bottom, other.bottom) - Math.max(hRect.top, other.top);
        if (overlapX > 1 && overlapY > 1) {
          errs.push(
            `Header obscured: pane ${ids[i]} header overlapped by pane ${ids[j]} by ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}px`
          );
        }
      }
    }

    // ========== 6. Rendered terminal width matches XState ==========
    // Only check width; height semantics differ between layout-string (includes border)
    // and content rows, making exact pixel comparison unreliable.
    for (let i = 0; i < items.length; i++) {
      const pane = (panes || []).find(p => p.tmuxId === ids[i]);
      if (!pane) continue;
      const termContent = items[i].querySelector('.terminal-content');
      if (!termContent) continue;
      const tRect = termContent.getBoundingClientRect();
      const expectedW = pane.width * charWidth;
      if (Math.abs(tRect.width - expectedW) > 2) {
        errs.push(
          `Dimensions: pane ${ids[i]} terminal width ${tRect.width.toFixed(1)}px != expected ${expectedW.toFixed(1)}px (${pane.width} cols * ${charWidth.toFixed(1)}px)`
        );
      }
    }

    // ========== 7. Exactly one .pane-active ==========
    // Skip when grid doesn't fit — overflow filter may exclude the active pane
    if (gridFits) {
      const activeItems = items.filter(el => el.classList.contains('pane-active'));
      if (activeItems.length !== 1) {
        errs.push(
          `Active pane: expected exactly 1 .pane-active element, found ${activeItems.length}`
        );
      } else {
        const activeId = activeItems[0].getAttribute('data-pane-id');
        if (activePaneId && activeId !== activePaneId) {
          errs.push(
            `Active pane: DOM .pane-active is ${activeId}, but XState activePaneId is ${activePaneId}`
          );
        }
      }
    }

    // ========== 8. Inter-pane gaps ==========
    if (cg && rects.length >= 2) {
      // Use terminal-content rects for gap measurement (excludes header/padding)
      const tRects = [];
      const tIds = [];
      for (let i = 0; i < items.length; i++) {
        const tc = items[i].querySelector('.terminal-content');
        if (tc) {
          tRects.push(tc.getBoundingClientRect());
          tIds.push(ids[i]);
        }
      }

      for (let i = 0; i < tRects.length; i++) {
        for (let j = i + 1; j < tRects.length; j++) {
          const a = tRects[i];
          const b = tRects[j];

          // Check horizontal (side-by-side): overlapping Y ranges, gap < 3*charWidth
          const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (yOverlap > 10) {
            if (a.right < b.left || b.right < a.left) {
              const hGap = a.right < b.left ? b.left - a.right : a.left - b.right;
              if (hGap < charWidth * 3) {
                const expected = charWidth;
                if (Math.abs(hGap - expected) > 6) {
                  errs.push(
                    `H-gap: pane ${tIds[i]} and ${tIds[j]}: ${hGap.toFixed(1)}px (expected ~${expected.toFixed(1)}px = 1 charWidth)`
                  );
                }
              }
            }
          }

          // Check vertical (stacked): overlapping X ranges, gap < 3*charHeight
          const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          if (xOverlap > 10) {
            if (a.bottom < b.top || b.bottom < a.top) {
              const vGap = a.bottom < b.top ? b.top - a.bottom : a.top - b.bottom;
              if (vGap < charHeight * 3) {
                const expected = charHeight;
                if (Math.abs(vGap - expected) > 6) {
                  errs.push(
                    `V-gap: pane ${tIds[i]} and ${tIds[j]}: ${vGap.toFixed(1)}px (expected ~${expected.toFixed(1)}px = 1 charHeight)`
                  );
                }
              }
            }
          }
        }
      }
    }

    return { errors: errs, skipped: false };
  }, { checkCentering: checkCentering, checkGaps: checkGaps });

  if (result.skipped) return;

  if (result.errors.length > 0) {
    throw new Error(
      `${prefix}Layout invariant failed:\n` +
      result.errors.map(e => `  - ${e}`).join('\n')
    );
  }
}

module.exports = {
  assertLayoutInvariants,
};
