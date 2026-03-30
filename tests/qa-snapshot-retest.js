/**
 * QA Snapshot Retest — focused on distinguishing real bugs from timing issues
 */
const { getBrowser, navigateToSession, waitForPaneCount, delay, waitForSessionReady } = require('./helpers/browser');
const { extractUIState, extractTmuxState, compareSnapshots } = require('./helpers/snapshot-compare');
const { focusTerminal, typeInTerminal, pressEnter } = require('./helpers/keyboard');
const { splitPaneKeyboard, killPaneKeyboard } = require('./helpers/pane-ops');
const { DELAYS } = require('./helpers/config');

const SESSION = 'tmuxy-qa';
const URL = 'http://localhost:9000';

async function main() {
  let browser, page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await navigateToSession(page, SESSION, URL);
    await waitForSessionReady(page, SESSION);
    await delay(3000); // Extra settle time

    // ===== RETEST 1: Split content propagation with longer wait =====
    console.warn('\n--- RETEST 1: Split Horizontal with 5s settle ---');
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    await delay(5000); // 5 full seconds

    let ui = await extractUIState(page);
    let tmux = extractTmuxState(SESSION);
    let cmp = compareSnapshots(ui, tmux);
    const failures1 = cmp.checks.filter(c => !c.pass);
    if (failures1.length > 0) {
      console.warn('STILL FAILS after 5s:');
      failures1.forEach(c => console.warn(`  ${c.name}: ${c.details}`));
    } else {
      console.warn('PASSES with 5s settle');
    }

    // Clean up
    await killPaneKeyboard(page);
    await waitForPaneCount(page, 1);
    await delay(2000);

    // ===== RETEST 2: Content mismatch with git prompt =====
    console.warn('\n--- RETEST 2: Content match after settle ---');
    await delay(3000);
    ui = await extractUIState(page);
    tmux = extractTmuxState(SESSION);
    cmp = compareSnapshots(ui, tmux);
    const failures2 = cmp.checks.filter(c => !c.pass);
    if (failures2.length > 0) {
      console.warn('Content mismatch at rest:');
      failures2.forEach(c => console.warn(`  ${c.name}: ${c.details}`));
    } else {
      console.warn('PASSES at rest');
    }

    // ===== RETEST 3: Float creation and close via keyboard =====
    console.warn('\n--- RETEST 3: Float create + close via keyboard Escape ---');
    await focusTerminal(page);
    await typeInTerminal(page, 'tmuxy pane float');
    await pressEnter(page);
    await delay(4000);

    ui = await extractUIState(page);
    console.warn(`Float panes detected: ${ui?.floatPaneIds?.length || 0}`);
    console.warn(`Float IDs: ${JSON.stringify(ui?.floatPaneIds)}`);

    // Check if float overlay exists in DOM
    const hasFloatOverlay = await page.evaluate(() => {
      return !!document.querySelector('.float-modal, .modal-overlay.float-modal');
    });
    console.warn(`Float overlay in DOM: ${hasFloatOverlay}`);

    // Try to close float by typing exit directly (not via focusTerminal which may fail)
    if (hasFloatOverlay) {
      // Click directly on the float's terminal
      const clicked = await page.evaluate(() => {
        const floatTerminal = document.querySelector('.float-modal [role="log"], .modal-overlay.float-modal [role="log"]');
        if (floatTerminal) {
          floatTerminal.click();
          return true;
        }
        return false;
      });
      console.warn(`Clicked float terminal: ${clicked}`);

      if (clicked) {
        await delay(500);
        // Type exit in the float
        for (const char of 'exit') {
          await page.keyboard.type(char);
          await delay(30);
        }
        await page.keyboard.press('Enter');
        await delay(3000);

        const stillHasFloat = await page.evaluate(() => {
          return !!document.querySelector('.float-modal, .modal-overlay.float-modal');
        });
        console.warn(`Float still in DOM after exit: ${stillHasFloat}`);

        ui = await extractUIState(page);
        tmux = extractTmuxState(SESSION);
        console.warn(`UI float panes: ${ui?.floatPaneIds?.length || 0}`);
        console.warn(`Tmux float panes: ${tmux?.floatPaneIds?.length || 0}`);
      }
    }

    // ===== RETEST 4: Content pipeline for newly split panes =====
    console.warn('\n--- RETEST 4: New pane content pipeline timing ---');
    await delay(2000);
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);

    // Poll content over time
    for (const waitSec of [1, 2, 3, 5, 8]) {
      await delay(waitSec * 1000 - (waitSec > 1 ? (waitSec - 1) * 1000 : 0));
      ui = await extractUIState(page);
      const newPane = ui?.panes?.find(p => !p.active);
      const paneId = newPane?.tmuxId;
      const content = paneId ? ui.paneContent[paneId] : [];
      const hasContent = content?.some(l => l.trim().length > 0);
      console.warn(`  ${waitSec}s: pane ${paneId} content=${hasContent ? 'YES' : 'EMPTY'} (${content?.filter(l => l.trim()).length || 0} non-empty lines)`);
      if (hasContent) break;
    }

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    if (page) {
      try { await page._context.close(); } catch {}
    }
    try {
      const { execSync } = require('child_process');
      execSync('tmux -L tmuxy-prod kill-session -t tmuxy-qa 2>/dev/null || true');
    } catch {}
  }
}

main().catch(e => { console.error('Unhandled:', e); process.exit(1); });
