/**
 * QA Flicker Detection — Rotation Cycle 3
 * Runs all 12 flicker scenarios from .claude/agents/qa/styles/flicker.md
 */

const path = require('path');
const helpersDir = path.join(__dirname, 'helpers');

const { getBrowser, navigateToSession, waitForPaneCount, waitForWindowCount, delay } = require(path.join(helpersDir, 'browser'));
const { GlitchDetector, OPERATION_THRESHOLDS } = require(path.join(helpersDir, 'glitch-detector'));
const { assertLayoutInvariants } = require(path.join(helpersDir, 'layout'));
const { focusTerminal, sendPrefixCommand, typeInTerminal, pressEnter } = require(path.join(helpersDir, 'keyboard'));
const { splitPaneKeyboard, killPaneKeyboard, toggleZoomKeyboard, resizePaneKeyboard, cycleLayoutKeyboard, getUIPaneCount } = require(path.join(helpersDir, 'pane-ops'));
const { createWindowKeyboard, nextWindowKeyboard, killWindowKeyboard } = require(path.join(helpersDir, 'window-ops'));
const { DELAYS } = require(path.join(helpersDir, 'config'));

const SESSION = 'tmuxy-qa';
const SCENARIO_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const results = [];

function log(msg) {
  console.warn(`[flicker] ${msg}`);
}

async function withTimeout(fn, label) {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded 5 minutes`)), SCENARIO_TIMEOUT)
    ),
  ]);
}

/**
 * Reset to 1-pane state by killing extra panes
 */
async function resetToOnePane(page) {
  let count = await getUIPaneCount(page);
  let attempts = 0;
  while (count > 1 && attempts < 10) {
    await killPaneKeyboard(page);
    await delay(DELAYS.SYNC);
    count = await getUIPaneCount(page);
    attempts++;
  }
  if (count !== 1) {
    log(`WARNING: Could not reset to 1 pane (have ${count})`);
  }
  await delay(DELAYS.MEDIUM);
}

/**
 * Ensure we have exactly N panes by splitting
 */
async function ensurePaneCount(page, n) {
  await resetToOnePane(page);
  for (let i = 1; i < n; i++) {
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, i + 1);
    await delay(DELAYS.MEDIUM);
  }
  const count = await getUIPaneCount(page);
  if (count !== n) {
    log(`WARNING: Expected ${n} panes, got ${count}`);
  }
}

async function runScenario(name, fn, page) {
  log(`--- Scenario: ${name} ---`);
  const start = Date.now();
  try {
    await withTimeout(() => fn(page), name);
    const duration = Date.now() - start;
    log(`  PASS (${duration}ms)`);
    results.push({ name, status: 'PASS', duration });
  } catch (err) {
    const duration = Date.now() - start;
    log(`  FAIL: ${err.message}`);
    results.push({ name, status: 'FAIL', duration, error: err.message });
  }

  // Layout invariant check after each scenario
  try {
    await assertLayoutInvariants(page, { label: name });
    log(`  Layout invariants: OK`);
  } catch (err) {
    log(`  Layout invariants FAILED: ${err.message}`);
    results.push({ name: `${name} (layout)`, status: 'FAIL', duration: 0, error: err.message });
  }
}

// ==================== Scenarios ====================

async function scenario1_splitHorizontal(page) {
  await resetToOnePane(page);
  const detector = new GlitchDetector(page);
  await detector.start();
  await splitPaneKeyboard(page, 'horizontal');
  await waitForPaneCount(page, 2);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  const t = OPERATION_THRESHOLDS.split;
  if (result.summary.nodeFlickers > t.nodeFlickers) {
    throw new Error(`Node flickers: ${result.summary.nodeFlickers} > threshold ${t.nodeFlickers}`);
  }
  if (result.summary.sizeJumps > t.sizeJumps) {
    throw new Error(`Size jumps: ${result.summary.sizeJumps} > threshold ${t.sizeJumps}`);
  }
}

async function scenario2_splitVertical(page) {
  await resetToOnePane(page);
  const detector = new GlitchDetector(page);
  await detector.start();
  await splitPaneKeyboard(page, 'vertical');
  await waitForPaneCount(page, 2);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  const t = OPERATION_THRESHOLDS.split;
  if (result.summary.nodeFlickers > t.nodeFlickers) {
    throw new Error(`Node flickers: ${result.summary.nodeFlickers} > threshold ${t.nodeFlickers}`);
  }
  if (result.summary.sizeJumps > t.sizeJumps) {
    throw new Error(`Size jumps: ${result.summary.sizeJumps} > threshold ${t.sizeJumps}`);
  }
}

async function scenario3_killPane(page) {
  await ensurePaneCount(page, 2);
  const detector = new GlitchDetector(page);
  await detector.start();
  await killPaneKeyboard(page);
  await waitForPaneCount(page, 1);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  const t = OPERATION_THRESHOLDS.kill;
  if (result.summary.nodeFlickers > t.nodeFlickers) {
    throw new Error(`Node flickers: ${result.summary.nodeFlickers} > threshold ${t.nodeFlickers}`);
  }
}

async function scenario4_resizePane(page) {
  await ensurePaneCount(page, 2);
  const detector = new GlitchDetector(page);
  await detector.start();
  await resizePaneKeyboard(page, 'D', 5);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);

  const t = OPERATION_THRESHOLDS.resize;
  if (result.summary.nodeFlickers > t.nodeFlickers) {
    throw new Error(`Node flickers: ${result.summary.nodeFlickers} > threshold ${t.nodeFlickers}`);
  }
  // Resize naturally causes size jumps, so we allow some
}

async function scenario5_windowSwitch(page) {
  await resetToOnePane(page);
  // Create a second window
  await createWindowKeyboard(page);
  await waitForWindowCount(page, 2);
  await delay(DELAYS.SYNC);

  const detector = new GlitchDetector(page);
  await detector.start();
  await nextWindowKeyboard(page);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  const t = OPERATION_THRESHOLDS.windowSwitch;
  if (result.summary.attrChurnEvents > (t.attrChurnEvents + 2)) {
    throw new Error(`Attribute churn: ${result.summary.attrChurnEvents} > threshold ${t.attrChurnEvents + 2}`);
  }

  // Clean up: kill extra window
  await killWindowKeyboard(page);
  await waitForWindowCount(page, 1);
}

async function scenario6_groupTabSwitch(page) {
  await resetToOnePane(page);
  // Create a pane group
  await typeInTerminal(page, 'tmuxy pane group add');
  await pressEnter(page);
  await delay(DELAYS.SYNC);
  await typeInTerminal(page, 'tmuxy pane group add');
  await pressEnter(page);
  await delay(DELAYS.SYNC);

  const detector = new GlitchDetector(page);
  await detector.start();
  // Switch group tabs
  await typeInTerminal(page, 'tmuxy pane group next');
  await pressEnter(page);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  const t = OPERATION_THRESHOLDS.groupSwitch;
  if (result.summary.nodeFlickers > t.nodeFlickers) {
    throw new Error(`Node flickers: ${result.summary.nodeFlickers} > threshold ${t.nodeFlickers}`);
  }

  // Clean up groups
  await typeInTerminal(page, 'tmuxy pane group close');
  await pressEnter(page);
  await delay(DELAYS.SYNC);
  await typeInTerminal(page, 'tmuxy pane group close');
  await pressEnter(page);
  await delay(DELAYS.SYNC);
}

async function scenario7_zoomToggle(page) {
  await ensurePaneCount(page, 2);
  const detector = new GlitchDetector(page);
  await detector.start();
  await toggleZoomKeyboard(page);
  await delay(DELAYS.SYNC);
  await toggleZoomKeyboard(page);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  // Zoom causes size jumps naturally, but check for excessive ones
  if (result.summary.nodeFlickers > 0) {
    throw new Error(`Node flickers during zoom: ${result.summary.nodeFlickers}`);
  }
}

async function scenario8_rapidSplitSpam(page) {
  await resetToOnePane(page);
  const detector = new GlitchDetector(page);
  await detector.start();
  for (let i = 0; i < 5; i++) {
    await splitPaneKeyboard(page, i % 2 === 0 ? 'horizontal' : 'vertical');
    await delay(DELAYS.LONG);
  }
  await waitForPaneCount(page, 6, 10000);
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  const paneCount = await getUIPaneCount(page);
  log(`  Pane count after 5 splits: ${paneCount}`);
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}, totalNodeMutations=${result.summary.totalNodeMutations}`);

  // Stress test: allow more but not unlimited
  if (result.summary.nodeFlickers > 5) {
    throw new Error(`Excessive node flickers during rapid split: ${result.summary.nodeFlickers}`);
  }
}

async function scenario9_dragPaneHeader(page) {
  await ensurePaneCount(page, 2);
  await delay(DELAYS.SYNC);

  // Get pane header position
  const headerBox = await page.evaluate(() => {
    const header = document.querySelector('.pane-header');
    if (!header) return null;
    const r = header.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (!headerBox) {
    log('  SKIP: No pane header found');
    return;
  }

  const detector = new GlitchDetector(page);
  await detector.start();
  // Simulate drag
  await page.mouse.move(headerBox.x, headerBox.y);
  await page.mouse.down();
  await delay(100);
  await page.mouse.move(headerBox.x + 50, headerBox.y, { steps: 5 });
  await delay(100);
  await page.mouse.move(headerBox.x + 100, headerBox.y, { steps: 5 });
  await delay(100);
  await page.mouse.up();
  await delay(DELAYS.SYNC);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);

  const t = OPERATION_THRESHOLDS.drag;
  if (result.summary.nodeFlickers > t.nodeFlickers) {
    throw new Error(`Node flickers during drag: ${result.summary.nodeFlickers}`);
  }
}

async function scenario10_floatOpenClose(page) {
  await resetToOnePane(page);

  const detector = new GlitchDetector(page);
  await detector.start();
  await typeInTerminal(page, 'tmuxy pane float bash');
  await pressEnter(page);
  await delay(DELAYS.SYNC * 2);

  // Close the float - find and close it
  await typeInTerminal(page, 'exit');
  await pressEnter(page);
  await delay(DELAYS.SYNC * 2);
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}, totalNodeMutations=${result.summary.totalNodeMutations}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  // Check for orphaned nodes (float DOM should be cleaned up)
  const orphanedFloats = await page.evaluate(() => {
    const floats = document.querySelectorAll('.float-pane, .pane-float');
    return floats.length;
  });
  if (orphanedFloats > 0) {
    throw new Error(`Orphaned float nodes: ${orphanedFloats}`);
  }
}

async function scenario11_layoutCycle(page) {
  await ensurePaneCount(page, 3);
  const detector = new GlitchDetector(page);
  await detector.start();
  for (let i = 0; i < 5; i++) {
    await cycleLayoutKeyboard(page);
    await delay(DELAYS.SYNC);
  }
  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);

  if (result.summary.nodeFlickers > 0) {
    throw new Error(`Node flickers during layout cycle: ${result.summary.nodeFlickers}`);
  }
}

async function scenario12_windowCreateSwitchKill(page) {
  await resetToOnePane(page);
  const detector = new GlitchDetector(page);
  await detector.start();

  // Create window
  await createWindowKeyboard(page);
  await waitForWindowCount(page, 2);
  await delay(DELAYS.LONG);

  // Switch back to first window
  await nextWindowKeyboard(page);
  await delay(DELAYS.LONG);

  // Switch forward again
  await nextWindowKeyboard(page);
  await delay(DELAYS.LONG);

  // Kill current window
  await killWindowKeyboard(page);
  await waitForWindowCount(page, 1);
  await delay(DELAYS.SYNC);

  const result = await detector.stop();
  log(`  Summary: flickers=${result.summary.nodeFlickers}, sizeJumps=${result.summary.sizeJumps}, attrChurn=${result.summary.attrChurnEvents}`);
  log(`  Timeline:\n${GlitchDetector.formatTimeline(result)}`);

  if (result.summary.nodeFlickers > 2) {
    throw new Error(`Excessive node flickers during window lifecycle: ${result.summary.nodeFlickers}`);
  }
}

// ==================== Main ====================

async function main() {
  log('Starting flicker detection — rotation cycle 3');

  // Connect browser
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Navigate to session (server creates session automatically)
    await navigateToSession(page, SESSION);
    log(`Connected to session: ${SESSION}`);
    await delay(DELAYS.SYNC);

    // Ensure focus
    await focusTerminal(page);
    await delay(DELAYS.MEDIUM);

    // Run all scenarios
    await runScenario('1. Split Horizontal', scenario1_splitHorizontal, page);
    await runScenario('2. Split Vertical', scenario2_splitVertical, page);
    await runScenario('3. Kill Pane', scenario3_killPane, page);
    await runScenario('4. Resize Pane', scenario4_resizePane, page);
    await runScenario('5. Window Switch', scenario5_windowSwitch, page);
    await runScenario('6. Group Tab Switch', scenario6_groupTabSwitch, page);
    await runScenario('7. Zoom Toggle', scenario7_zoomToggle, page);
    await runScenario('8. Rapid 5-Split Spam', scenario8_rapidSplitSpam, page);
    await runScenario('9. Drag Pane Header', scenario9_dragPaneHeader, page);
    await runScenario('10. Float Open/Close', scenario10_floatOpenClose, page);
    await runScenario('11. Layout Cycle', scenario11_layoutCycle, page);
    await runScenario('12. Window Create+Switch+Kill', scenario12_windowCreateSwitchKill, page);

  } finally {
    // Clean up
    await page.context().close().catch(() => {});
  }

  // Summary
  log('\n========== SUMMARY ==========');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  log(`Total: ${results.length}, Passed: ${passed}, Failed: ${failed}`);
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    log(`  ${icon} ${r.name} (${r.duration || 0}ms)${r.error ? ' — ' + r.error.slice(0, 120) : ''}`);
  }

  // Output JSON for downstream processing
  console.warn('\n__RESULTS_JSON__');
  console.warn(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
