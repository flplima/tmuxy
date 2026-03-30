/**
 * QA Flicker Detection — Rerun failed scenarios 10, 11 (layout), 12
 */

const path = require('path');
const helpersDir = path.join(__dirname, 'helpers');

const { getBrowser, navigateToSession, waitForPaneCount, waitForWindowCount, delay } = require(path.join(helpersDir, 'browser'));
const { GlitchDetector, OPERATION_THRESHOLDS } = require(path.join(helpersDir, 'glitch-detector'));
const { assertLayoutInvariants } = require(path.join(helpersDir, 'layout'));
const { focusTerminal, sendPrefixCommand, typeInTerminal, pressEnter } = require(path.join(helpersDir, 'keyboard'));
const { splitPaneKeyboard, killPaneKeyboard, cycleLayoutKeyboard, getUIPaneCount } = require(path.join(helpersDir, 'pane-ops'));
const { createWindowKeyboard, nextWindowKeyboard, killWindowKeyboard } = require(path.join(helpersDir, 'window-ops'));
const { DELAYS } = require(path.join(helpersDir, 'config'));

const SESSION = 'tmuxy-qa';

function log(msg) {
  console.warn(`[flicker-rerun] ${msg}`);
}

async function resetToOnePane(page) {
  let count = await getUIPaneCount(page);
  let attempts = 0;
  while (count > 1 && attempts < 10) {
    await killPaneKeyboard(page);
    await delay(DELAYS.SYNC);
    count = await getUIPaneCount(page);
    attempts++;
  }
  await delay(DELAYS.MEDIUM);
}

async function ensurePaneCount(page, n) {
  await resetToOnePane(page);
  for (let i = 1; i < n; i++) {
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, i + 1);
    await delay(DELAYS.MEDIUM);
  }
}

async function main() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await navigateToSession(page, SESSION);
    await delay(DELAYS.SYNC);
    await focusTerminal(page);

    // ========== Re-test Scenario 10: Float Open/Close ==========
    log('--- Scenario 10: Float Open/Close (retry) ---');
    await resetToOnePane(page);
    await delay(DELAYS.SYNC);

    const detector10 = new GlitchDetector(page);
    await detector10.start();

    // Open float
    await typeInTerminal(page, 'tmuxy pane float bash');
    await pressEnter(page);
    await delay(DELAYS.SYNC * 3);

    // Close the float by clicking the float's close button or using keyboard
    // The float modal intercepts clicks, so use keyboard approach
    // Send 'exit' directly to the float pane via keyboard
    await page.keyboard.type('exit');
    await delay(200);
    await page.keyboard.press('Enter');
    await delay(DELAYS.SYNC * 3);

    const result10 = await detector10.stop();
    log(`  Summary: flickers=${result10.summary.nodeFlickers}, sizeJumps=${result10.summary.sizeJumps}, attrChurn=${result10.summary.attrChurnEvents}`);
    log(`  Timeline:\n${GlitchDetector.formatTimeline(result10)}`);

    // Check for orphaned float nodes
    const orphanedFloats = await page.evaluate(() => {
      const floats = document.querySelectorAll('.float-modal, .modal-overlay.float-modal');
      return { count: floats.length, html: floats.length > 0 ? floats[0].outerHTML.slice(0, 200) : '' };
    });
    log(`  Orphaned float elements: ${orphanedFloats.count}`);
    if (orphanedFloats.count > 0) {
      log(`  Float HTML: ${orphanedFloats.html}`);
    }

    // Check if float window still exists in tmux
    const floatWindows = await page.evaluate(() => {
      const snap = window.app?.getSnapshot();
      return snap?.context?.windows?.filter(w => w.isFloatWindow).map(w => `${w.id}:${w.name}`) || [];
    });
    log(`  Remaining float windows in XState: ${JSON.stringify(floatWindows)}`);

    // ========== Re-test Scenario 11: Layout Cycle centering ==========
    log('--- Scenario 11: Layout Cycle (centering re-check) ---');
    // Clean up any floats first
    await resetToOnePane(page);
    await delay(DELAYS.SYNC);
    await ensurePaneCount(page, 3);
    await delay(DELAYS.SYNC);

    // Check centering before cycling
    try {
      await assertLayoutInvariants(page, { label: 'before-cycle' });
      log('  Layout before cycle: OK');
    } catch (err) {
      log(`  Layout before cycle FAILED: ${err.message}`);
    }

    // Cycle through all 5 layouts
    for (let i = 0; i < 5; i++) {
      await cycleLayoutKeyboard(page);
      await delay(DELAYS.SYNC);

      // Get current layout info
      const layoutInfo = await page.evaluate(() => {
        const snap = window.app?.getSnapshot();
        const container = document.querySelector('.pane-container');
        const cRect = container?.getBoundingClientRect();
        const items = document.querySelectorAll('.pane-layout-item[data-pane-id]');
        let minLeft = Infinity, maxRight = -Infinity;
        for (const el of items) {
          const r = el.getBoundingClientRect();
          minLeft = Math.min(minLeft, r.left);
          maxRight = Math.max(maxRight, r.right);
        }
        return {
          layoutString: snap?.context?.panes?.[0]?.layout || 'unknown',
          containerWidth: cRect?.width,
          leftMargin: minLeft - (cRect?.left || 0),
          rightMargin: (cRect?.right || 0) - maxRight,
          paneCount: items.length,
        };
      });
      log(`  Layout ${i+1}: leftM=${layoutInfo.leftMargin.toFixed(0)}px, rightM=${layoutInfo.rightMargin.toFixed(0)}px, panes=${layoutInfo.paneCount}`);
    }

    // Final centering check
    try {
      await assertLayoutInvariants(page, { label: 'after-cycle' });
      log('  Layout after cycle: OK');
    } catch (err) {
      log(`  Layout after cycle FAILED: ${err.message}`);
    }

    // ========== Re-test Scenario 12: Window Create+Switch+Kill ==========
    log('--- Scenario 12: Window Create+Switch+Kill (retry) ---');
    await resetToOnePane(page);
    await delay(DELAYS.SYNC);

    // Verify clean state - no float windows
    const preState = await page.evaluate(() => {
      const snap = window.app?.getSnapshot();
      return {
        windows: snap?.context?.windows?.map(w => `${w.id}:${w.name}:float=${w.isFloatWindow}`) || [],
        tabCount: document.querySelectorAll('.tab-name:not(.tab-add)').length,
      };
    });
    log(`  Pre-state: windows=${JSON.stringify(preState.windows)}, tabs=${preState.tabCount}`);

    const detector12 = new GlitchDetector(page);
    await detector12.start();

    await createWindowKeyboard(page);
    await waitForWindowCount(page, 2, 15000);
    await delay(DELAYS.LONG);

    await nextWindowKeyboard(page);
    await delay(DELAYS.LONG);

    await nextWindowKeyboard(page);
    await delay(DELAYS.LONG);

    await killWindowKeyboard(page);
    await waitForWindowCount(page, 1, 15000);
    await delay(DELAYS.SYNC);

    const result12 = await detector12.stop();
    log(`  Summary: flickers=${result12.summary.nodeFlickers}, sizeJumps=${result12.summary.sizeJumps}, attrChurn=${result12.summary.attrChurnEvents}`);
    log(`  Timeline:\n${GlitchDetector.formatTimeline(result12)}`);

    if (result12.summary.nodeFlickers > 2) {
      log(`  FAIL: Excessive node flickers: ${result12.summary.nodeFlickers}`);
    } else {
      log('  PASS');
    }

  } finally {
    await page.context().close().catch(() => {});
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
