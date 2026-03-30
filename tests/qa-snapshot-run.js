/**
 * QA Snapshot Test Runner — Rotation Cycle 3
 * Runs all 13 snapshot scenarios from snapshot.md
 */

const { getBrowser, navigateToSession, waitForPaneCount, waitForWindowCount, delay, waitForSessionReady } = require('./helpers/browser');
const { extractUIState, extractTmuxState, compareSnapshots } = require('./helpers/snapshot-compare');
const { assertLayoutInvariants } = require('./helpers/layout');
const { focusTerminal, sendPrefixCommand, typeInTerminal, pressEnter } = require('./helpers/keyboard');
const { splitPaneKeyboard, killPaneKeyboard, getUIPaneCount } = require('./helpers/pane-ops');
const { createWindowKeyboard, nextWindowKeyboard, renameWindowKeyboard, selectWindowKeyboard } = require('./helpers/window-ops');
const { DELAYS } = require('./helpers/config');

const SESSION = 'tmuxy-qa';
const URL = 'http://localhost:9000';

// Results tracking
const results = [];
function logResult(scenario, pass, details = '') {
  results.push({ scenario, pass, details });
  const icon = pass ? '✅' : '❌';
  console.warn(`${icon} Scenario: ${scenario}${details ? ' — ' + details : ''}`);
}

// Compare and return formatted result
function runCompare(ui, tmux, label) {
  if (!ui) return { pass: false, details: 'UI state extraction returned null' };
  if (!tmux) return { pass: false, details: 'Tmux state extraction returned null' };
  const result = compareSnapshots(ui, tmux);
  if (!result.pass) {
    const failures = result.checks.filter(c => !c.pass).map(c => `${c.name}: ${c.details || 'FAIL'}`);
    return { pass: false, details: failures.join('; ') };
  }
  return { pass: true, details: '' };
}

async function snapshot(page) {
  await delay(DELAYS.SYNC);
  const ui = await extractUIState(page);
  const tmux = extractTmuxState(SESSION);
  return { ui, tmux };
}

async function main() {
  let browser, page;

  try {
    browser = await getBrowser();
    page = await browser.newPage();

    // Navigate to session (server creates it automatically)
    await navigateToSession(page, SESSION, URL);
    await waitForSessionReady(page, SESSION);
    await delay(DELAYS.SYNC);

    // ===== Scenario 1: Single Pane Baseline =====
    try {
      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Single Pane Baseline');
      if (cmp.pass) {
        // Verify single pane
        const paneOk = ui.panes.length === 1 && tmux.panes.length === 1;
        const winOk = ui.windows.length === 1 && tmux.windows.length === 1;
        logResult('1. Single Pane Baseline', paneOk && winOk,
          !paneOk ? `Pane count: UI=${ui.panes.length}, tmux=${tmux.panes.length}` :
          !winOk ? `Window count: UI=${ui.windows.length}, tmux=${tmux.windows.length}` : '');
      } else {
        logResult('1. Single Pane Baseline', false, cmp.details);
      }
    } catch (e) {
      logResult('1. Single Pane Baseline', false, e.message);
    }

    // ===== Scenario 2: Split Horizontal =====
    try {
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await delay(DELAYS.SYNC);
      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Split Horizontal');
      const paneOk = ui && tmux && ui.panes.length === 2 && tmux.panes.length === 2;
      logResult('2. Split Horizontal', cmp.pass && paneOk,
        !cmp.pass ? cmp.details : !paneOk ? `Pane counts: UI=${ui?.panes?.length}, tmux=${tmux?.panes?.length}` : '');
    } catch (e) {
      logResult('2. Split Horizontal', false, e.message);
    }

    // Kill the extra pane to reset to 1 pane
    await killPaneKeyboard(page);
    await waitForPaneCount(page, 1);
    await delay(DELAYS.SYNC);

    // ===== Scenario 3: Split Vertical =====
    try {
      await splitPaneKeyboard(page, 'vertical');
      await waitForPaneCount(page, 2);
      await delay(DELAYS.SYNC);
      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Split Vertical');
      const paneOk = ui && tmux && ui.panes.length === 2 && tmux.panes.length === 2;
      logResult('3. Split Vertical', cmp.pass && paneOk,
        !cmp.pass ? cmp.details : !paneOk ? `Pane counts: UI=${ui?.panes?.length}, tmux=${tmux?.panes?.length}` : '');
    } catch (e) {
      logResult('3. Split Vertical', false, e.message);
    }

    // Kill the extra pane to reset to 1 pane
    await killPaneKeyboard(page);
    await waitForPaneCount(page, 1);
    await delay(DELAYS.SYNC);

    // ===== Scenario 4: Kill Pane =====
    try {
      // Split first to get 2 panes
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await delay(DELAYS.SYNC);

      // Kill pane via command
      await killPaneKeyboard(page);
      await waitForPaneCount(page, 1);
      await delay(DELAYS.SYNC);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Kill Pane');
      const paneOk = ui && tmux && ui.panes.length === 1 && tmux.panes.length === 1;
      logResult('4. Kill Pane', cmp.pass && paneOk,
        !cmp.pass ? cmp.details : !paneOk ? `Pane counts: UI=${ui?.panes?.length}, tmux=${tmux?.panes?.length}` : '');
    } catch (e) {
      logResult('4. Kill Pane', false, e.message);
    }

    // ===== Scenario 5: Create Second Window =====
    try {
      await createWindowKeyboard(page);
      await waitForWindowCount(page, 2);
      await delay(DELAYS.SYNC);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Create Second Window');
      const winOk = ui && tmux && ui.windows.length === 2 && tmux.windows.length === 2;
      logResult('5. Create Second Window', cmp.pass && winOk,
        !cmp.pass ? cmp.details : !winOk ? `Window counts: UI=${ui?.windows?.length}, tmux=${tmux?.windows?.length}` : '');
    } catch (e) {
      logResult('5. Create Second Window', false, e.message);
    }

    // ===== Scenario 6: Switch Windows =====
    try {
      // We're on window 2, switch to window 1
      const beforeUI = await extractUIState(page);
      const beforeActiveWin = beforeUI?.meta?.activeWindowId;

      await nextWindowKeyboard(page);
      await delay(DELAYS.SYNC);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Switch Windows');
      const switched = ui && beforeActiveWin && ui.meta.activeWindowId !== beforeActiveWin;
      logResult('6. Switch Windows', cmp.pass && switched,
        !cmp.pass ? cmp.details : !switched ? `Active window didn't change: before=${beforeActiveWin}, after=${ui?.meta?.activeWindowId}` : '');
    } catch (e) {
      logResult('6. Switch Windows', false, e.message);
    }

    // Kill the second window to reset
    // Switch back to window 2 and kill it
    await nextWindowKeyboard(page);
    await delay(DELAYS.SYNC);
    const { killWindowKeyboard } = require('./helpers/window-ops');
    await killWindowKeyboard(page);
    await waitForWindowCount(page, 1);
    await delay(DELAYS.SYNC);

    // ===== Scenario 7: Create Float =====
    try {
      await focusTerminal(page);
      await typeInTerminal(page, 'tmuxy pane float');
      await pressEnter(page);
      await delay(3000); // Float creation takes time

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Create Float');
      const hasFloat = ui && ui.floatPaneIds.length > 0;
      logResult('7. Create Float', cmp.pass && hasFloat,
        !cmp.pass ? cmp.details : !hasFloat ? `No float panes detected in UI` : '');
    } catch (e) {
      logResult('7. Create Float', false, e.message);
    }

    // ===== Scenario 8: Close Float =====
    try {
      // Type exit in the float pane to close it
      await delay(500);
      await focusTerminal(page);
      await typeInTerminal(page, 'exit');
      await pressEnter(page);
      await delay(3000);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Close Float');
      const noFloat = ui && ui.floatPaneIds.length === 0;
      logResult('8. Close Float', cmp.pass && noFloat,
        !cmp.pass ? cmp.details : !noFloat ? `Float panes still present: ${ui?.floatPaneIds}` : '');
    } catch (e) {
      logResult('8. Close Float', false, e.message);
    }

    // ===== Scenario 9: Create Pane Group =====
    try {
      await focusTerminal(page);
      await typeInTerminal(page, 'tmuxy pane group add');
      await pressEnter(page);
      await delay(3000);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Create Pane Group');
      const hasGroup = ui && Object.keys(ui.paneGroups).length > 0;
      logResult('9. Create Pane Group', cmp.pass && hasGroup,
        !cmp.pass ? cmp.details : !hasGroup ? 'No pane groups detected' : '');
    } catch (e) {
      logResult('9. Create Pane Group', false, e.message);
    }

    // ===== Scenario 10: Switch Group Tabs =====
    try {
      // Add another pane to the group
      await focusTerminal(page);
      await typeInTerminal(page, 'tmuxy pane group add');
      await pressEnter(page);
      await delay(3000);

      // Now switch group tabs
      await focusTerminal(page);
      await typeInTerminal(page, 'tmuxy pane group prev');
      await pressEnter(page);
      await delay(2000);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Switch Group Tabs');
      logResult('10. Switch Group Tabs', cmp.pass, !cmp.pass ? cmp.details : '');
    } catch (e) {
      logResult('10. Switch Group Tabs', false, e.message);
    }

    // Clean up groups - close group panes
    try {
      await focusTerminal(page);
      await typeInTerminal(page, 'tmuxy pane group close');
      await pressEnter(page);
      await delay(2000);
      await focusTerminal(page);
      await typeInTerminal(page, 'tmuxy pane group close');
      await pressEnter(page);
      await delay(2000);
    } catch (e) {
      // Ignore cleanup errors
    }

    // ===== Scenario 11: Rename Window =====
    try {
      await renameWindowKeyboard(page, 'test-rename');
      await delay(DELAYS.SYNC);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Rename Window');
      const nameOk = ui && ui.windows.some(w => w.name === 'test-rename');
      const tmuxNameOk = tmux && tmux.windows.some(w => w.name === 'test-rename');
      logResult('11. Rename Window', cmp.pass && nameOk && tmuxNameOk,
        !cmp.pass ? cmp.details :
        !nameOk ? `UI window name not 'test-rename': ${JSON.stringify(ui?.windows?.map(w => w.name))}` :
        !tmuxNameOk ? `tmux window name not 'test-rename': ${JSON.stringify(tmux?.windows?.map(w => w.name))}` : '');
    } catch (e) {
      logResult('11. Rename Window', false, e.message);
    }

    // ===== Scenario 12: Rapid Split+Kill Cycle =====
    try {
      // Split 3 times to get 4 panes
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await delay(DELAYS.LONG);

      await splitPaneKeyboard(page, 'vertical');
      await waitForPaneCount(page, 3);
      await delay(DELAYS.LONG);

      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 4);
      await delay(DELAYS.SYNC);

      // Kill 2 panes
      await killPaneKeyboard(page);
      await waitForPaneCount(page, 3);
      await delay(DELAYS.LONG);

      await killPaneKeyboard(page);
      await waitForPaneCount(page, 2);
      await delay(DELAYS.SYNC);

      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Rapid Split+Kill Cycle');
      const paneOk = ui && tmux && ui.panes.length === 2 && tmux.panes.length === 2;
      logResult('12. Rapid Split+Kill Cycle', cmp.pass && paneOk,
        !cmp.pass ? cmp.details : !paneOk ? `Pane counts: UI=${ui?.panes?.length}, tmux=${tmux?.panes?.length}` : '');
    } catch (e) {
      logResult('12. Rapid Split+Kill Cycle', false, e.message);
    }

    // Kill extra panes to reset
    const currentPanes = await getUIPaneCount(page);
    for (let i = currentPanes; i > 1; i--) {
      await killPaneKeyboard(page);
      await waitForPaneCount(page, i - 1);
      await delay(DELAYS.LONG);
    }
    await delay(DELAYS.SYNC);

    // ===== Scenario 13: Multi-Window Full Comparison =====
    try {
      // Window 1: split to get 3 panes
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await delay(DELAYS.LONG);
      await splitPaneKeyboard(page, 'vertical');
      await waitForPaneCount(page, 3);
      await delay(DELAYS.SYNC);

      // Create window 2
      await createWindowKeyboard(page);
      await waitForWindowCount(page, 2);
      await delay(DELAYS.SYNC);

      // Split window 2 to get 2 panes
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await delay(DELAYS.SYNC);

      // Full comparison
      const { ui, tmux } = await snapshot(page);
      const cmp = runCompare(ui, tmux, 'Multi-Window Full Comparison');

      // Also run layout invariants
      let layoutOk = true;
      let layoutErr = '';
      try {
        await assertLayoutInvariants(page);
      } catch (e) {
        layoutOk = false;
        layoutErr = e.message;
      }

      const winOk = ui && tmux && ui.windows.length === 2 && tmux.windows.length === 2;
      logResult('13. Multi-Window Full Comparison', cmp.pass && winOk && layoutOk,
        !cmp.pass ? cmp.details :
        !winOk ? `Window counts: UI=${ui?.windows?.length}, tmux=${tmux?.windows?.length}` :
        !layoutOk ? `Layout invariant: ${layoutErr}` : '');
    } catch (e) {
      logResult('13. Multi-Window Full Comparison', false, e.message);
    }

  } catch (e) {
    console.error('Fatal error:', e.message);
  } finally {
    // Clean up
    if (page) {
      try { await page._context.close(); } catch {}
    }
    try {
      const { execSync } = require('child_process');
      execSync('tmux -L tmuxy-prod kill-session -t tmuxy-qa 2>/dev/null || true');
    } catch {}

    // Summary
    console.warn('\n========== SUMMARY ==========');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.warn(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

    if (failed > 0) {
      console.warn('\nFailed scenarios:');
      for (const r of results.filter(r => !r.pass)) {
        console.warn(`  ❌ ${r.scenario}: ${r.details}`);
      }
    }

    // Output results as JSON for parsing
    console.warn('\n__RESULTS_JSON__');
    console.warn(JSON.stringify(results));
  }
}

main().catch(e => {
  console.error('Unhandled:', e);
  process.exit(1);
});
