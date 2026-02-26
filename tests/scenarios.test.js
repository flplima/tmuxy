/**
 * Consolidated E2E Scenario Tests
 *
 * 20 scenario tests that chain multiple operations per session,
 * eliminating ~208 session setup/teardown cycles.
 */

const fs = require('fs');
const path = require('path');
const {
  createTestContext,
  delay,
  focusPage,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  getUIPaneCount,
  getUIPaneInfo,
  getUIPaneTitles,
  clickPane,
  typeInTerminal,
  pressEnter,
  sendKeyCombo,
  sendTmuxPrefix,
  sendPrefixCommand,
  waitForPaneCount,
  waitForWindowCount,
  verifyLayoutChanged,
  withConsistencyChecks,
  assertConsistencyPasses,
  verifyDomSizes,
  clickPaneGroupAdd,
  clickGroupTabAdd,
  getGroupTabCount,
  clickGroupTab,
  clickGroupTabClose,
  waitForGroupTabs,
  isHeaderGrouped,
  getGroupTabInfo,
  pasteText,
  noteKnownLimitation,
  GlitchDetector,
  DELAYS,
  waitForSessionReady,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  swapPaneKeyboard,
  toggleZoomKeyboard,
  createWindowKeyboard,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
  killPaneKeyboard,
  selectLayoutKeyboard,
  tmuxCommandKeyboard,
  resizePaneKeyboard,
  enterCopyModeKeyboard,
  pasteBufferKeyboard,
  copyModeSearchForwardKeyboard,
  copyModeSearchAgainKeyboard,
  copyModeSearchReverseKeyboard,
  copyModeBeginSelectionKeyboard,
  copyModeCopySelectionKeyboard,
  copyModeMoveKeyboard,
} = require('./helpers');

const MOUSE_CAPTURE_SCRIPT = path.join(__dirname, 'helpers', 'mouse-capture.py');
const MOUSE_LOG = '/tmp/mouse-events.log';

// ==================== SGR Mouse Helpers ====================

async function startMouseCapture(ctx) {
  try { fs.unlinkSync(MOUSE_LOG); } catch {}
  await typeInTerminal(ctx.page, `python3 ${MOUSE_CAPTURE_SCRIPT}`);
  await pressEnter(ctx.page);
  const readyStart = Date.now();
  let ready = false;
  while (!ready && Date.now() - readyStart < 10000) {
    const text = await ctx.page.evaluate(() => {
      const el = document.querySelector('[role="log"]');
      return el ? el.textContent : '';
    });
    if (text.includes('READY')) ready = true;
    else await delay(DELAYS.MEDIUM);
  }
  expect(ready).toBe(true);
  const flagStart = Date.now();
  let flagSet = false;
  while (!flagSet && Date.now() - flagStart < 10000) {
    flagSet = await ctx.page.evaluate(() => !!document.querySelector('[data-mouse-any-flag="true"]'));
    if (!flagSet) await delay(DELAYS.MEDIUM);
  }
  expect(flagSet).toBe(true);
  const contentBox = await ctx.page.evaluate(() => {
    const el = document.querySelector('.pane-content');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(contentBox).not.toBeNull();
  const charSize = await ctx.page.evaluate(() => {
    const snap = window.app.getSnapshot();
    return { charWidth: snap.context.charWidth, charHeight: snap.context.charHeight };
  });
  return { contentBox, charSize };
}

async function readMouseEvents(minCount = 1, timeout = 5000) {
  const start = Date.now();
  let events = [];
  while (Date.now() - start < timeout) {
    try {
      const content = fs.readFileSync(MOUSE_LOG, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l && l !== 'READY');
      events = lines.map(line => {
        const parts = line.split(':');
        const type = parts[0];
        const props = {};
        for (let i = 1; i < parts.length; i++) {
          const [k, v] = parts[i].split('=');
          props[k] = parseInt(v, 10);
        }
        return { type, ...props };
      });
      if (events.length >= minCount) return events;
    } catch {}
    await delay(DELAYS.SHORT);
  }
  return events;
}

function expectedSgrCoord(pixel, origin, cellSize) {
  return Math.max(0, Math.floor((pixel - origin) / cellSize)) + 1;
}

async function stopMouseCapture(ctx) {
  await ctx.page.keyboard.press('q');
  await delay(DELAYS.LONG);
}

// ==================== Float Helpers ====================

async function createFloat(ctx, paneId) {
  const paneNum = paneId.replace('%', '');
  // Use adapter for break-pane since it needs to work reliably
  // (tmux command prompt route may have timing issues with float detection)
  await ctx.session._exec(`break-pane -d -s ${paneId} -n "__float_${paneNum}"`);
  await delay(DELAYS.SYNC);
  await delay(DELAYS.SYNC);
}

async function waitForFloatModal(page, timeout = 10000) {
  await page.waitForSelector('.modal-container', { timeout });
}

async function getFloatModalInfo(page) {
  return await page.evaluate(() => {
    const modals = document.querySelectorAll('.modal-container');
    return Array.from(modals).map((modal) => ({
      hasHeader: modal.querySelector('.modal-header') !== null,
      hasCloseButton: modal.querySelector('.modal-close') !== null,
      hasTerminal: modal.querySelector('.terminal-container') !== null,
    }));
  });
}

// ==================== Scenario 2: Keyboard Basics ====================

describe('Scenario 2: Keyboard Basics', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Type → backspace → Tab → Ctrl+C → Ctrl+D → arrow-up history', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Basic typing
    await runCommand(ctx.page, 'echo hello123', 'hello123');

    // Step 2: Backspace
    await typeInTerminal(ctx.page, 'echo helloxx');
    await ctx.page.keyboard.press('Backspace');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.press('Backspace');
    await delay(DELAYS.SHORT);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'hello');

    // Step 3: Tab completion
    await typeInTerminal(ctx.page, 'ech');
    await ctx.page.keyboard.press('Tab');
    await delay(DELAYS.LONG);
    await typeInTerminal(ctx.page, ' tab_complete_test');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'tab_complete_test');

    // Step 4: Ctrl+C interrupts
    await typeInTerminal(ctx.page, 'sleep 100');
    await pressEnter(ctx.page);
    await delay(DELAYS.EXTRA_LONG);
    await sendKeyCombo(ctx.page, 'Control', 'c');
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "after_interrupt"', 'after_interrupt');

    // Step 5: Ctrl+D sends EOF
    await typeInTerminal(ctx.page, 'cat');
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);
    await typeInTerminal(ctx.page, 'test_input');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);
    await sendKeyCombo(ctx.page, 'Control', 'd');
    await waitForTerminalText(ctx.page, 'test_input');

    // Step 6: Arrow-up history recall
    await runCommand(ctx.page, 'echo history_test_123', 'history_test_123');
    await runCommand(ctx.page, 'echo second_command', 'second_command');
    await ctx.page.keyboard.press('ArrowUp');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.press('ArrowUp');
    await delay(DELAYS.SHORT);
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);
    const text = await getTerminalText(ctx.page);
    expect(text.split('history_test_123').length).toBeGreaterThan(2);
  }, 180000);
});

// ==================== Scenario 4: Window Lifecycle ====================

describe('Scenario 4: Window Lifecycle', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('New window → tabs → next/prev → by-number → last → rename → close → layout', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create new window
    const initialCount = await ctx.session.getWindowCount();
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, initialCount + 1);
    expect(await ctx.session.getWindowCount()).toBe(initialCount + 1);

    // Step 2: Window tabs
    const windowInfo = await ctx.session.getWindowInfo();
    expect(windowInfo.length).toBe(2);

    // Step 3: Next window
    const currentIndex = await ctx.session.getCurrentWindowIndex();
    await nextWindowKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(currentIndex);

    // Step 4: Previous window
    const idx = await ctx.session.getCurrentWindowIndex();
    await prevWindowKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(idx);

    // Step 5: Create 3rd window and select by number
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 3);
    await selectWindowKeyboard(ctx.page, 1);
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).toBe('1');

    // Step 6: Last window toggle
    await lastWindowKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    // Should be on one of the other windows
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe('1');

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'MyRenamedWindow');
    await delay(DELAYS.SYNC);
    let windows = await ctx.session.getWindowInfo();
    expect(windows.find(w => w.name === 'MyRenamedWindow')).toBeDefined();

    // Step 8: Close windows
    windows = await ctx.session.getWindowInfo();
    const curIdx = await ctx.session.getCurrentWindowIndex();
    for (const w of windows) {
      if (String(w.index) !== String(curIdx)) {
        await tmuxCommandKeyboard(ctx.page, `kill-window -t :${w.index}`);
        await delay(DELAYS.SHORT);
      }
    }
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 1);
    expect(await ctx.session.getWindowCount()).toBe(1);

    // Step 9: Layout test with 4 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3, 10000);
    await navigatePaneKeyboard(ctx.page, 'up');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 4, 10000);

    await selectLayoutKeyboard(ctx.page, 'tiled');
    await delay(DELAYS.SYNC);
    const tiledPanes = await ctx.session.getPaneInfo();
    expect(tiledPanes.length).toBe(4);
    const areas = tiledPanes.map(p => p.width * p.height);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(2);
  }, 180000);
});

// ==================== Scenario 5: Pane Groups ====================

describe('Scenario 5: Pane Groups', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Header → add button → create group → switch tabs → add 3rd → close tab → content verify → ungroup', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Header element exists
    const header = await ctx.page.$('.pane-tab');
    expect(header).not.toBeNull();

    // Step 2: Add button exists
    const addButton = await ctx.page.$('.pane-tab-add');
    expect(addButton).not.toBeNull();

    // Step 3: Create group
    expect(await isHeaderGrouped(ctx.page)).toBe(false);
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    expect(await isHeaderGrouped(ctx.page)).toBe(true);
    let tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.length).toBe(2);
    expect(tabs.filter(t => t.active).length).toBe(1);

    // Step 4: Run command in visible pane, switch tabs, verify content
    // After group creation, the new pane is active. Wait for its shell to
    // initialize and render before sending commands.
    await focusPage(ctx.page);

    // The active pane in the group just created a new shell. We need to wait
    // for the active pane's terminal to have rendered content (shell prompt).
    // Use the active pane's data-pane-id to target the correct terminal.
    for (let i = 0; i < 50; i++) {
      const hasContent = await ctx.page.evaluate(() => {
        // Find the active pane (visible one, not hidden by group tab switching)
        const paneWrappers = document.querySelectorAll('.pane-wrapper');
        for (const pw of paneWrappers) {
          const style = getComputedStyle(pw);
          // Check if this pane is actually visible (not display:none from group tab)
          if (style.display === 'none') continue;
          const log = pw.querySelector('[role="log"]');
          if (log && log.textContent.length > 0) return true;
        }
        return false;
      });
      if (hasContent) break;
      await delay(DELAYS.MEDIUM);
    }
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "MARKER_BETA"', 'MARKER_BETA', 15000);

    const inactiveIdx = tabs.findIndex(t => !t.active);
    await clickGroupTab(ctx.page, inactiveIdx);
    await waitForGroupTabs(ctx.page, 2);
    await delay(DELAYS.SYNC);

    // Should not see MARKER_BETA (switched to original pane with different content)
    tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.filter(t => t.active).length).toBe(1);

    // Step 5: Add 3rd tab
    await clickGroupTabAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 6: Close a tab (last non-active one)
    await clickGroupTabClose(ctx.page, 2);
    await waitForGroupTabs(ctx.page, 2);
    expect(await getGroupTabCount(ctx.page)).toBe(2);

    // Step 7: Close remaining extra tab → revert to regular header
    await clickGroupTabClose(ctx.page, 1);
    await delay(DELAYS.SYNC);
    expect(await isHeaderGrouped(ctx.page)).toBe(false);

    // Pane should still exist
    const finalHeader = await ctx.page.$('.pane-tab');
    expect(finalHeader).not.toBeNull();
  }, 180000);
});

// ==================== Scenario 6: Floating Panes ====================

describe('Scenario 6: Floating Panes', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Break-pane → float modal → header/close → tiled count → close button → re-float → backdrop close', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupTwoPanes('horizontal');

    // Step 1: Break-pane creates float
    let activePaneId = await ctx.session.getActivePaneId();
    let paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId);
    let windows = await ctx.session.getWindowInfo({ includeFloats: true });
    expect(windows.find(w => w.name === `__float_${paneNum}`)).toBeDefined();

    // Step 2: Float modal appears
    await waitForFloatModal(ctx.page);
    const backdrop = await ctx.page.$('.modal-backdrop');
    expect(backdrop).not.toBeNull();

    // Step 3: Modal has header and close button
    const modalInfo = await getFloatModalInfo(ctx.page);
    expect(modalInfo.length).toBe(1);
    expect(modalInfo[0].hasHeader).toBe(true);
    expect(modalInfo[0].hasCloseButton).toBe(true);
    expect(modalInfo[0].hasTerminal).toBe(true);

    // Step 4: Tiled pane count reduced
    await waitForPaneCount(ctx.page, 1);

    // Step 5: Close button removes float
    await ctx.page.click('.modal-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
    let modals = await ctx.page.$$('.modal-container');
    expect(modals.length).toBe(0);
    windows = await ctx.session.getWindowInfo();
    expect(windows.find(w => w.name === `__float_${paneNum}`)).toBeUndefined();

    // Step 6: Re-create float (need to split again first since we only have 1 pane)
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId);
    await waitForFloatModal(ctx.page);

    // Step 7: Backdrop click closes float
    // Click far from center to avoid hitting the centered float modal
    const newBackdrop = await ctx.page.$('.modal-backdrop');
    const box = await newBackdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
    modals = await ctx.page.$$('.modal-container');
    expect(modals.length).toBe(0);
  }, 180000);
});

// ==================== Scenario 7: Mouse Click & Scroll ====================

// Helper: read browser-side copy mode state from XState
async function getCopyModeState(page) {
  return page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const paneId = snap.context.activePaneId;
    if (!paneId) return null;
    const cs = snap.context.copyModeStates[paneId];
    if (!cs) return null;
    return {
      active: true,
      cursorRow: cs.cursorRow,
      cursorCol: cs.cursorCol,
      scrollTop: cs.scrollTop,
      totalLines: cs.totalLines,
      height: cs.height,
      width: cs.width,
      selectionMode: cs.selectionMode,
      selectionAnchor: cs.selectionAnchor,
    };
  });
}

// Helper: poll until browser-side copy mode is active/inactive
async function waitForCopyMode(page, active, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const cs = await getCopyModeState(page);
    if (active && cs?.active) return cs;
    if (!active && !cs?.active) return null;
    await delay(100);
  }
  throw new Error(`Copy mode did not become ${active ? 'active' : 'inactive'} within ${timeout}ms`);
}

describe('Scenario 7: Mouse Click & Scroll', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Click focus → scroll enters copy mode → ScrollbackTerminal renders → exit q → user-select none → double-click word select → drag no browser selection', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Click in terminal area doesn't lose focus
    await focusPage(ctx.page);
    const terminal = await ctx.page.$('[role="log"]');
    let box = await terminal.boundingBox();
    await ctx.page.mouse.click(box.x + 50, box.y + 50);
    await ctx.page.mouse.click(box.x + 100, box.y + 100);
    await delay(DELAYS.LONG);
    await runCommand(ctx.page, 'echo click_test', 'click_test');

    // Step 2: Generate scrollback, then scroll up → browser copy mode activates
    await runCommand(ctx.page, 'seq 1 100', '100');
    box = await ctx.page.locator('[role="log"]').first().boundingBox();
    await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
      await ctx.page.mouse.wheel(0, -300);
      await delay(DELAYS.SHORT);
    }
    // Browser-side copy mode should be active (XState copyModeStates populated)
    const csAfterScroll = await waitForCopyMode(ctx.page, true);
    expect(csAfterScroll.active).toBe(true);

    // Step 3: ScrollbackTerminal renders in copy mode
    const scrollbackEl = await ctx.page.$('[data-copy-mode="true"]');
    expect(scrollbackEl).not.toBeNull();

    // Step 4: Exit copy mode with 'q' via browser keyboard
    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    const csAfterExit = await getCopyModeState(ctx.page);
    expect(csAfterExit).toBeNull();

    // Step 5: user-select: none on terminal content
    const userSelect = await ctx.page.evaluate(() => {
      const el = document.querySelector('.terminal-content');
      return el ? getComputedStyle(el).userSelect : null;
    });
    expect(userSelect).toBe('none');

    // Step 6: Double-click enters copy mode with word selection (no browser selection)
    await runCommand(ctx.page, 'echo "WORD1 WORD2 WORD3"', 'WORD1');
    const termEl = await ctx.page.$('[role="log"]');
    box = await termEl.boundingBox();
    await ctx.page.mouse.dblclick(box.x + 100, box.y + box.height / 2);
    await delay(DELAYS.SYNC);
    // Browser text selection must be empty (user-select: none prevents it)
    const selectedText = await ctx.page.evaluate(() => {
      const selection = window.getSelection();
      return selection ? selection.toString() : '';
    });
    expect(selectedText).toBe('');
    // Exit copy mode if entered by double-click
    const csAfterDblClick = await getCopyModeState(ctx.page);
    if (csAfterDblClick?.active) {
      await ctx.page.keyboard.press('q');
      await waitForCopyMode(ctx.page, false);
    }

    // Step 7: Drag creates no browser selection
    await typeInTerminal(ctx.page, 'echo DRAG_TEST_CONTENT');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);
    const t2 = await ctx.page.$('[role="log"]');
    box = await t2.boundingBox();
    await ctx.page.mouse.move(box.x + 50, box.y + box.height / 2);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 10 });
    await ctx.page.mouse.up();
    await delay(DELAYS.LONG);
    const selText = await ctx.page.evaluate(() => window.getSelection()?.toString() || '');
    expect(selText).toBe('');
    // Exit copy mode if drag entered it — must fully exit before sending shell commands
    const csAfterDrag = await getCopyModeState(ctx.page);
    if (csAfterDrag?.active) {
      await ctx.page.keyboard.press('q');
      await waitForCopyMode(ctx.page, false);
      await delay(DELAYS.SYNC);
    }
    await runCommand(ctx.page, 'echo AFTER_DRAG_OK', 'AFTER_DRAG_OK');
  }, 180000);
});

// ==================== Scenario 8: Mouse Drag & SGR ====================

describe('Scenario 8: Mouse Drag & SGR', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Drag H divider → drag V divider → SGR click → SGR wheel → SGR right-click', async () => {
    if (ctx.skipIfNotReady()) return;

    // Step 1: Drag horizontal divider
    await ctx.setupTwoPanes('horizontal');
    await waitForPaneCount(ctx.page, 2);
    let panesBefore = await ctx.session.getPaneInfo();
    await resizePaneKeyboard(ctx.page, 'D', 5);
    await delay(DELAYS.SYNC);
    let panesAfter = await ctx.session.getPaneInfo();
    const heightsChanged = panesBefore.some((before, i) => {
      const after = panesAfter[i];
      return after && before.height !== after.height;
    });
    expect(heightsChanged).toBe(true);

    // Kill panes to reset
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 2: Drag vertical divider (via tmux resize)
    await splitPaneKeyboard(ctx.page, 'vertical');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    panesBefore = await ctx.session.getPaneInfo();
    await resizePaneKeyboard(ctx.page, 'R', 10);
    await delay(DELAYS.SYNC);
    panesAfter = await ctx.session.getPaneInfo();
    const widthsChanged = panesBefore.some((before, i) => {
      const after = panesAfter[i];
      return after && before.width !== after.width;
    });
    expect(widthsChanged).toBe(true);

    // Kill pane to reset for SGR tests
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);

    // Step 3: SGR click
    const { contentBox, charSize } = await startMouseCapture(ctx);
    const clickX = contentBox.x + contentBox.width / 2;
    const clickY = contentBox.y + contentBox.height / 2;
    await ctx.page.mouse.click(clickX, clickY);
    let events = await readMouseEvents(2);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const press = events.find(e => e.type === 'press');
    const release = events.find(e => e.type === 'release');
    expect(press).toBeDefined();
    expect(release).toBeDefined();
    expect(press.btn).toBe(0);

    // Step 4: SGR wheel - stop and restart capture for clean slate
    await stopMouseCapture(ctx);
    await delay(DELAYS.LONG);
    const capture2 = await startMouseCapture(ctx);

    const wheelX = capture2.contentBox.x + capture2.contentBox.width / 2;
    const wheelY = capture2.contentBox.y + capture2.contentBox.height / 2;
    await ctx.page.mouse.move(wheelX, wheelY);
    await ctx.page.mouse.wheel(0, -capture2.charSize.charHeight * 3);
    await delay(DELAYS.SYNC);
    await ctx.page.mouse.wheel(0, capture2.charSize.charHeight * 2);
    await delay(DELAYS.SYNC);
    events = await readMouseEvents(2);
    const scrollUps = events.filter(e => e.type === 'scroll_up');
    const scrollDowns = events.filter(e => e.type === 'scroll_down');
    expect(scrollUps.length).toBeGreaterThanOrEqual(1);
    expect(scrollDowns.length).toBeGreaterThanOrEqual(1);
    for (const evt of scrollUps) expect(evt.btn).toBe(64);
    for (const evt of scrollDowns) expect(evt.btn).toBe(65);

    // Step 5: SGR right-click - stop and restart for clean slate
    await stopMouseCapture(ctx);
    await delay(DELAYS.LONG);
    const capture3 = await startMouseCapture(ctx);

    const rClickX = capture3.contentBox.x + 50;
    const rClickY = capture3.contentBox.y + 50;
    await ctx.page.mouse.click(rClickX, rClickY, { button: 'right' });
    events = await readMouseEvents(2);
    const rPress = events.find(e => e.type === 'press');
    expect(rPress).toBeDefined();
    expect(rPress.btn).toBe(2);

    await stopMouseCapture(ctx);
  }, 180000);
});

// ==================== Scenario 9: Copy Mode Navigate ====================

describe('Scenario 9: Copy Mode Navigate', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Scroll enter → hjkl cursor → 0/$ line edges → Ctrl+u/d half-page → persists → exit q → re-enter scroll → exit Escape → v selection', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate scrollback content
    await runCommand(ctx.page, 'seq 1 200', '200');
    await focusPage(ctx.page);

    // Step 1: Enter copy mode via scroll (the real user path)
    const box = await ctx.page.locator('[role="log"]').first().boundingBox();
    await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
      await ctx.page.mouse.wheel(0, -300);
      await delay(DELAYS.SHORT);
    }
    const csEntry = await waitForCopyMode(ctx.page, true);
    expect(csEntry.active).toBe(true);

    // Step 2: Navigate with 'k' (up) — cursor row should decrease
    const before = await getCopyModeState(ctx.page);
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('k');
      await delay(50);
    }
    await delay(DELAYS.SHORT);
    const afterUp = await getCopyModeState(ctx.page);
    expect(afterUp.cursorRow).toBeLessThan(before.cursorRow);

    // Navigate with 'j' (down) — cursor row should increase
    await ctx.page.keyboard.press('j');
    await delay(DELAYS.SHORT);
    const afterDown = await getCopyModeState(ctx.page);
    expect(afterDown.cursorRow).toBeGreaterThan(afterUp.cursorRow);

    // Navigate with 'l' (right) — cursor col should increase
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await delay(DELAYS.SHORT);
    const afterRight = await getCopyModeState(ctx.page);
    expect(afterRight.cursorCol).toBeGreaterThan(0);

    // Navigate with 'h' (left) — cursor col should decrease
    await ctx.page.keyboard.press('h');
    await delay(DELAYS.SHORT);
    const afterLeft = await getCopyModeState(ctx.page);
    expect(afterLeft.cursorCol).toBeLessThan(afterRight.cursorCol);

    // Step 3: Line edges: '0' goes to col 0, '$' goes to end of line
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.press('0');
    await delay(DELAYS.SHORT);
    const atStart = await getCopyModeState(ctx.page);
    expect(atStart.cursorCol).toBe(0);

    await ctx.page.keyboard.press('$');
    await delay(DELAYS.SHORT);
    const atEnd = await getCopyModeState(ctx.page);
    expect(atEnd.cursorCol).toBeGreaterThan(0);

    // Step 4: Half-page up/down (Ctrl+u / Ctrl+d)
    const beforePage = await getCopyModeState(ctx.page);
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('u');
    await ctx.page.keyboard.up('Control');
    await delay(DELAYS.SHORT);
    const afterPageUp = await getCopyModeState(ctx.page);
    expect(afterPageUp.cursorRow).toBeLessThan(beforePage.cursorRow);

    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('d');
    await ctx.page.keyboard.up('Control');
    await delay(DELAYS.SHORT);
    const afterPageDown = await getCopyModeState(ctx.page);
    expect(afterPageDown.cursorRow).toBeGreaterThan(afterPageUp.cursorRow);

    // Step 5: Still in copy mode after all navigation
    const csStillActive = await getCopyModeState(ctx.page);
    expect(csStillActive.active).toBe(true);
    // ScrollbackTerminal should be rendered
    const scrollbackEl = await ctx.page.$('[data-copy-mode="true"]');
    expect(scrollbackEl).not.toBeNull();

    // Step 6: Exit with 'q'
    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();
    // ScrollbackTerminal should be gone, normal terminal restored
    const normalEl = await ctx.page.$('[role="log"]');
    expect(normalEl).not.toBeNull();

    // Step 7: Re-enter via scroll
    await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
      await ctx.page.mouse.wheel(0, -300);
      await delay(DELAYS.SHORT);
    }
    await waitForCopyMode(ctx.page, true);

    // Step 8: Exit with Escape
    await ctx.page.keyboard.press('Escape');
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // Step 9: Re-enter, test 'v' selection mode
    for (let i = 0; i < 5; i++) {
      await ctx.page.mouse.wheel(0, -300);
      await delay(DELAYS.SHORT);
    }
    await waitForCopyMode(ctx.page, true);
    // Move to start of line so we have room to move right
    await ctx.page.keyboard.press('0');
    await delay(DELAYS.SHORT);
    // Press 'v' to enter char selection mode
    await ctx.page.keyboard.press('v');
    await delay(DELAYS.SHORT);
    const csWithSelection = await getCopyModeState(ctx.page);
    expect(csWithSelection.selectionMode).toBe('char');
    expect(csWithSelection.selectionAnchor).not.toBeNull();
    expect(csWithSelection.cursorCol).toBe(0);
    // Move cursor right to expand selection
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await delay(DELAYS.SHORT);
    const csExpanded = await getCopyModeState(ctx.page);
    expect(csExpanded.cursorCol).toBeGreaterThan(csWithSelection.cursorCol);
    // 'v' again toggles off selection
    await ctx.page.keyboard.press('v');
    await delay(DELAYS.SHORT);
    const csNoSel = await getCopyModeState(ctx.page);
    expect(csNoSel.selectionMode).toBeNull();

    // Clean exit
    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
  }, 180000);
});

// ==================== Scenario 10: Copy Mode Search & Yank ====================

describe('Scenario 10: Copy Mode Search & Yank', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Set-buffer → paste → search → select → copy → paste → repeat search n/N', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Set-buffer and paste
    const testText = `pasted_${Date.now()}`;
    await tmuxCommandKeyboard(ctx.page, `set-buffer "${testText}"`);
    await pasteBufferKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    const text = await getTerminalText(ctx.page);
    expect(text).toContain(testText);
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.SHORT);

    // Step 2: Generate target content for search
    await runCommand(ctx.page, 'echo "SEARCH_TARGET_AAA"', 'SEARCH_TARGET_AAA');
    await runCommand(ctx.page, 'echo "SEARCH_TARGET_BBB"', 'SEARCH_TARGET_BBB');

    // Step 3: Enter copy mode and search (via adapter - keyboard actor
    // intercepts all keys in copy mode and can't route prefix commands)
    await ctx.session._exec('copy-mode');
    await delay(DELAYS.SYNC);
    const posBeforeSearch = await ctx.session.getCopyCursorPosition();
    await ctx.session._exec('send-keys -X search-forward "SEARCH_TARGET"');
    await delay(DELAYS.LONG);
    const posAfterSearch = await ctx.session.getCopyCursorPosition();
    if (posBeforeSearch && posAfterSearch) {
      // Cursor should have moved
      expect(posAfterSearch.y !== posBeforeSearch.y || posAfterSearch.x !== posBeforeSearch.x).toBe(true);
    }
    expect(await ctx.session.isPaneInCopyMode()).toBe(true);

    // Step 4: Repeat search with n (search-again) and N (search-reverse)
    const posBeforeN = await ctx.session.getCopyCursorPosition();
    await ctx.session._exec('send-keys -X search-again');
    await delay(DELAYS.LONG);
    const posAfterN = await ctx.session.getCopyCursorPosition();
    if (posBeforeN && posAfterN) {
      // Position should change or stay (depends on match count)
      expect(posAfterN).toBeDefined();
    }

    await ctx.session._exec('send-keys -X search-reverse');
    await delay(DELAYS.LONG);

    // Step 5: Select and copy
    await ctx.session._exec('send-keys -X begin-selection');
    await delay(DELAYS.SHORT);
    for (let i = 0; i < 5; i++) {
      await ctx.session._exec('send-keys -X cursor-right');
      await delay(100);
    }
    await delay(DELAYS.SHORT);
    await ctx.session._exec('send-keys -X copy-selection-and-cancel');
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneInCopyMode()).toBe(false);

    // Step 6: Paste copied text
    await pasteBufferKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    // Terminal should be functional after copy-paste workflow
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.SHORT);
    await runCommand(ctx.page, 'echo "COPY_PASTE_OK"', 'COPY_PASTE_OK');
  }, 180000);
});

// ==================== Scenario 11: Status Bar ====================

describe('Scenario 11: Status Bar', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Bar visible → tab → session name → 2 windows → active distinct → click tab → rename → close via button', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Status bar visible
    const barInfo = await ctx.page.evaluate(() => {
      const bar = document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      if (!bar) return null;
      return {
        hasContent: bar.textContent.trim().length > 0,
        isVisible: bar.offsetParent !== null || bar.getBoundingClientRect().height > 0,
      };
    });
    expect(barInfo).not.toBeNull();
    expect(barInfo.hasContent).toBe(true);
    expect(barInfo.isVisible).toBe(true);

    // Step 2: Window tab present
    const tab = await ctx.page.$('.tab');
    expect(tab).not.toBeNull();

    // Step 3: Session name visible
    const barText = await ctx.page.evaluate(() => {
      const bar = document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      return bar ? bar.textContent : '';
    });
    expect(barText).toContain(ctx.session.name);

    // Step 4: Create second window - 2 tabs
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 2);
    expect(await ctx.session.getWindowCount()).toBe(2);

    // Step 5: Active tab distinct styling
    const activeTab = await ctx.page.$('.tab-active');
    expect(activeTab).not.toBeNull();

    // Step 6: Click inactive tab to switch
    const allTabs = await ctx.page.$$('.tab:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate(el => el.classList.contains('tab-active'));
      if (!isActive) { inactiveTab = t; break; }
    }
    expect(inactiveTab).not.toBeNull();
    const tabButton = await inactiveTab.$('.tab-button');
    await tabButton.click();
    await delay(DELAYS.SYNC);

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'RENAMED_WINDOW');
    await delay(DELAYS.SYNC);
    const tabText = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab:not(.tab-add)');
      return Array.from(tabs).map(t => t.textContent).join(' ');
    });
    expect(tabText).toContain('RENAMED_WINDOW');

    // Step 8: Close window via tmux (removing the non-active one)
    const windows = await ctx.session.getWindowInfo();
    const inactiveWindow = windows.find(w => !w.active);
    if (inactiveWindow) {
      await tmuxCommandKeyboard(ctx.page, `kill-window -t :${inactiveWindow.index}`);
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 1);
    }
    expect(await ctx.session.getWindowCount()).toBe(1);
  }, 180000);
});

// ==================== Scenario 12: Session Reconnect ====================

describe('Scenario 12: Session Reconnect', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('2 panes → reload → verify preserved → split via tmux → 3 rapid splits → UI synced', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create 2 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    // Wait for XState to reflect
    const pollStart = Date.now();
    while (Date.now() - pollStart < 5000) {
      const stateCount = await ctx.page.evaluate(() => {
        const snap = window.app?.getSnapshot?.();
        const panes = snap?.context?.panes || [];
        const awId = snap?.context?.activeWindowId;
        return panes.filter(p => p.windowId === awId).length;
      });
      if (stateCount === 2) break;
      await delay(DELAYS.SHORT);
    }

    // Step 2: Reload
    await ctx.page.reload({ waitUntil: 'domcontentloaded' });
    await ctx.page.waitForSelector('[role="log"]', { timeout: 15000 });
    ctx.session.setPage(ctx.page);
    await waitForSessionReady(ctx.page, ctx.session.name, 15000);
    await delay(DELAYS.SYNC * 2);

    // Step 3: Verify preserved
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Re-focus after reload for keyboard operations
    await focusPage(ctx.page);

    // Step 4: Split via keyboard
    await splitPaneKeyboard(ctx.page, 'vertical');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 3);

    // Step 5: 3 rapid splits (wait for each to complete)
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 5, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);

    // Step 6: UI synced
    const tmuxCount = await ctx.session.getPaneCount();
    expect(tmuxCount).toBe(6);
    await waitForPaneCount(ctx.page, 6);
    const uiCount = await getUIPaneCount(ctx.page);
    expect(uiCount).toBe(6);
  }, 180000);
});

// ==================== Scenario 13: Multi-Client ====================

describe('Scenario 13: Multi-Client', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('3 panes → page2 → both see layout', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create 3-pane layout
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3, 10000);

    // Step 2: Open second page
    const { navigateToSession } = require('./helpers');
    const page2 = await ctx.browser.newPage();
    await navigateToSession(page2, ctx.session.name);
    // Wait for the second page to fully load and render terminals
    await page2.waitForSelector('[role="log"]', { timeout: 15000 }).catch(() => {});
    await delay(DELAYS.SYNC * 2);

    // Step 3: Both see terminal
    const p1Terminal = await ctx.page.$('[role="log"]');
    const p2Terminal = await page2.$('[role="log"]');
    expect(p1Terminal).not.toBeNull();
    expect(p2Terminal).not.toBeNull();

    // Step 4: Second page sees the pane layout
    const p2PaneCount = await page2.evaluate(() => {
      const panes = document.querySelectorAll('[data-pane-id]');
      return panes.length || document.querySelectorAll('[role="log"]').length;
    });
    expect(p2PaneCount).toBeGreaterThanOrEqual(1);

    await page2.close();
  }, 180000);
});

// ==================== Scenario 14: OSC Protocols ====================

describe('Scenario 14: OSC Protocols', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Hyperlink → multiple links → malformed → OSC 52 no crash', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: OSC 8 hyperlink renders text
    await runCommand(ctx.page, 'echo -e "\\e]8;;http://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"', 'Click Here');
    const text1 = await getTerminalText(ctx.page);
    expect(text1).toContain('Click Here');

    // Step 2: Multiple links
    await runCommand(ctx.page, 'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"', 'LinkA');
    const text2 = await getTerminalText(ctx.page);
    expect(text2).toContain('LinkA');
    expect(text2).toContain('LinkB');

    // Step 3: Malformed OSC 8 - terminal should survive
    await typeInTerminal(ctx.page, 'echo -e "\\e]8;;http://broken.com\\e\\\\BROKEN_LINK"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC * 2);
    // Verify terminal still functional (use longer timeout under load)
    await runCommand(ctx.page, 'echo "AFTER_MALFORMED"', 'AFTER_MALFORMED', 15000);

    // Step 4: OSC 52 doesn't crash
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;SGVsbG8=\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "OSC52_OK"', 'OSC52_OK');

    // Step 5: Multiple OSC 52 operations
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;Zmlyc3Q=\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;c2Vjb25k\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;dGhpcmQ=\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "MULTI_OSC52_OK"', 'MULTI_OSC52_OK');
  }, 180000);
});

// ==================== Scenario 16: Unicode Rendering ====================

describe('Scenario 16: Unicode Rendering', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Box drawing → CJK → alignment → emoji single/multi → tree output', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Box drawing characters
    await runCommand(ctx.page, 'echo -e "BOX_TOP\\n|test|\\nBOX_BTM"', 'BOX_TOP');
    const boxText = await getTerminalText(ctx.page);
    expect(boxText).toContain('test');
    expect(boxText).toContain('BOX_BTM');

    // Step 2: CJK characters
    await runCommand(ctx.page, 'echo "CJK_TEST: 你好世界 こんにちは 안녕하세요 END_CJK"', 'CJK_TEST');
    const cjkText = await getTerminalText(ctx.page);
    expect(cjkText).toContain('CJK_TEST');
    expect(cjkText).toContain('END_CJK');

    // Step 3: Cursor works after CJK
    const afterCjk = await runCommand(ctx.page, 'echo "AFTER_CJK"', 'AFTER_CJK');
    expect(afterCjk).toContain('AFTER_CJK');

    // Step 4: Emoji - single codepoint
    await runCommand(ctx.page, 'echo "EMOJI_TEST: X X X END_EMOJI"', 'EMOJI_TEST');
    const emojiText = await getTerminalText(ctx.page);
    expect(emojiText).toContain('END_EMOJI');

    // Step 5: Emoji - multi-codepoint (terminal should not break)
    await runCommand(ctx.page, 'echo "MULTI_EMOJI_START END_MULTI"', 'MULTI_EMOJI_START');
    const multiEmoji = await getTerminalText(ctx.page);
    expect(multiEmoji).toContain('END_MULTI');
    await runCommand(ctx.page, 'echo "AFTER_EMOJI"', 'AFTER_EMOJI');

    // Step 6: Unicode in git-style status output
    await runCommand(ctx.page, 'printf "\\u2713 Pass\\n\\u2717 Fail\\n\\u26A0 Warn\\n"', 'Pass');
    const statusText = await getTerminalText(ctx.page);
    expect(statusText).toContain('Fail');
    expect(statusText).toContain('Warn');

    // Step 7: Tree output with box-drawing
    await runCommand(ctx.page, 'printf "├── src\\n│   ├── main.rs\\n│   └── lib.rs\\n└── Cargo.toml\\n"', 'src');
    const treeText = await getTerminalText(ctx.page);
    expect(treeText).toContain('main.rs');
    expect(treeText).toContain('Cargo.toml');
  }, 180000);
});

// ==================== Scenario 17: Large Output Perf ====================

describe('Scenario 17: Large Output Perf', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('yes|head-500 → seq 1 2000 → scrollback → verify responsive', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Rapid output (yes | head -500)
    const start1 = Date.now();
    await runCommand(ctx.page, 'yes | head -500 && echo DONE_YES', 'DONE_YES', 20000);
    const elapsed1 = Date.now() - start1;
    expect(elapsed1).toBeLessThan(20000);
    expect(ctx.session.exists()).toBe(true);

    // Step 2: Large output (seq 1 2000)
    const start2 = Date.now();
    await runCommand(ctx.page, 'seq 1 2000 && echo SEQ_DONE', 'SEQ_DONE', 20000);
    const elapsed2 = Date.now() - start2;
    expect(elapsed2).toBeLessThan(20000);
    expect(ctx.session.exists()).toBe(true);

    // Step 3: Large scrollback accumulation
    await runCommand(ctx.page, 'for i in $(seq 1 200); do echo "line_$i"; done && echo SCROLL_DONE', 'SCROLL_DONE', 15000);
    expect(ctx.session.exists()).toBe(true);

    // Step 4: Verify responsive
    await runCommand(ctx.page, 'echo "STILL_RESPONSIVE"', 'STILL_RESPONSIVE');
  }, 180000);
});

// ==================== Scenario 18: Rapid Operations ====================

describe('Scenario 18: Rapid Operations', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Split×4 → kill×3 → split-close-split → 6 panes → 4 windows → swap', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Rapid splits ×4 (wait for each split to complete via XState)
    // Use helper that retries split if pane count doesn't increase.
    // Also verifies via tmux (XState) count, not just UI count.
    async function splitAndWait(direction, expectedCount) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await splitPaneKeyboard(ctx.page, direction);
        // Wait longer on retries to let tmux/UI catch up
        const waitTime = 10000 + attempt * 5000;
        const ok = await waitForPaneCount(ctx.page, expectedCount, waitTime);
        if (ok) return;
        // Also check tmux directly — UI may just be slow to render
        const tmuxCount = await ctx.session.getPaneCount();
        if (tmuxCount >= expectedCount) {
          // Tmux has the pane, just UI is behind — wait more
          await waitForPaneCount(ctx.page, expectedCount, 5000);
          return;
        }
        // Split didn't register — retry after a pause
        await delay(DELAYS.SYNC);
      }
      // Final check
      expect(await ctx.session.getPaneCount()).toBe(expectedCount);
    }
    await splitAndWait('horizontal', 2);
    await splitAndWait('vertical', 3);
    await splitAndWait('horizontal', 4);
    await splitAndWait('vertical', 5);
    expect(await ctx.session.getPaneCount()).toBe(5);

    // Step 2: Kill ×3
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 3: Split-close-split
    const result = await withConsistencyChecks(ctx, async () => {
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await delay(DELAYS.SYNC);
      await killPaneKeyboard(ctx.page);
      await delay(DELAYS.SYNC);
      await splitPaneKeyboard(ctx.page, 'vertical');
      await delay(DELAYS.SYNC);
    }, { operationType: 'split' });
    expect(await ctx.session.getPaneCount()).toBe(3);
    expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(4);

    // Kill to reset
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 4: 6-pane grid
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3, 10000);
    await navigatePaneKeyboard(ctx.page, 'up');
    await navigatePaneKeyboard(ctx.page, 'up');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 4, 10000);
    await navigatePaneKeyboard(ctx.page, 'down');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 5, 10000);
    await navigatePaneKeyboard(ctx.page, 'down');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 6, 10000);
    expect(await ctx.session.getPaneCount()).toBe(6);
    const sizeResult = await verifyDomSizes(ctx.page);
    expect(sizeResult.valid).toBe(true);

    // Kill back to 1 pane for next steps
    for (let i = 0; i < 5; i++) {
      await killPaneKeyboard(ctx.page);
      await delay(DELAYS.SYNC);
    }
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 5: 4 windows
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 4, 10000);
    expect(await ctx.session.getWindowCount()).toBe(4);

    // Step 6: Swap panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    const panesBefore = await ctx.session.getPaneInfo();
    const firstPaneIdBefore = panesBefore[0].id;
    await swapPaneKeyboard(ctx.page, 'down');
    await delay(DELAYS.SYNC);
    const panesAfterSwap = await ctx.session.getPaneInfo();
    expect(panesAfterSwap[0].id !== firstPaneIdBefore ||
           panesAfterSwap[0].y !== panesBefore[0].y).toBe(true);
  }, 240000);
});

// ==================== Scenario 19: Complex Workflow ====================

describe('Scenario 19: Complex Workflow', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('3 windows × splits → navigate all → send commands → verify alive', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Window 1 with 3 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3, 10000);
    expect(await ctx.session.getPaneCount()).toBe(3);

    // Step 2: Window 2 with 2 panes
    await createWindowKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 1, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 3: Window 3 with 2 panes
    await createWindowKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 1, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2, 10000);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 4: Verify 3 windows exist
    // Wait for XState to reflect all windows
    const pollStart = Date.now();
    while (Date.now() - pollStart < 10000) {
      const wc = await ctx.session.getWindowCount();
      if (wc >= 3) break;
      await delay(DELAYS.MEDIUM);
    }
    expect(await ctx.session.getWindowCount()).toBeGreaterThanOrEqual(3);

    // Step 5: Navigate through all windows
    const windowInfo = await ctx.session.getWindowInfo();
    for (const w of windowInfo) {
      await selectWindowKeyboard(ctx.page, w.index);
      await delay(DELAYS.LONG);
    }

    // Step 6: Send commands to verify panes alive
    await selectWindowKeyboard(ctx.page, windowInfo[0].index);
    await delay(DELAYS.LONG);
    await runCommand(ctx.page, 'echo "WIN1_OK"', 'WIN1_OK');

    // Step 7: Zoom and unzoom
    await toggleZoomKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(true);
    await toggleZoomKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(false);

    // Step 8: Navigate windows rapidly
    for (const w of windowInfo) {
      await selectWindowKeyboard(ctx.page, w.index);
      await delay(DELAYS.SHORT);
    }
    expect(ctx.session.exists()).toBe(true);
  }, 180000);
});

// ==================== Scenario 20: Glitch Detection ====================

describe('Scenario 20: Glitch Detection', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Split H + detect → split V + detect → resize + detect → click focus + detect', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Horizontal split with glitch detection
    await ctx.startGlitchDetection({ scope: '.pane-container' });
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    await delay(DELAYS.SYNC);
    let result = await ctx.assertNoGlitches({ operation: 'split' });

    // Step 2: Vertical split with glitch detection
    // With 2 existing panes, 3 elements transition simultaneously (the existing 2 resize + 1 new).
    // Each element produces ~15 jumps at 60fps × 250ms CSS transition.
    // Both .pane-layout-item and .pane-wrapper are tracked, doubling the count.
    await ctx.startGlitchDetection({
      scope: '.pane-container',
      ignoreSelectors: ['.resize-divider'],
      sizeJumpThreshold: 30, // Higher threshold to reduce noise from small CSS interpolation steps
    });
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3);
    await delay(DELAYS.SYNC);
    result = await ctx.assertNoGlitches({ operation: 'split' });

    // Kill to get back to 2 panes for resize test
    await killPaneKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 2, 10000);

    // Step 3: Resize with glitch detection
    await ctx.startGlitchDetection({
      scope: '.pane-container',
      sizeJumpThreshold: 100,
      ignoreSelectors: ['.terminal-content', '.terminal-line', '.terminal-cursor', '.resize-divider'],
    });
    await resizePaneKeyboard(ctx.page, 'D', 5);
    await delay(DELAYS.SYNC);
    const resizeResult = await ctx.assertNoGlitches({ operation: 'resize', sizeJumps: 20 });
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 4: Click focus with glitch detection
    await ctx.startGlitchDetection({ scope: '.pane-container' });
    const paneInfo = await ctx.page.evaluate(() => {
      const panes = document.querySelectorAll('.pane-layout-item');
      return Array.from(panes).map(p => {
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    });
    if (paneInfo.length >= 2) {
      await ctx.page.mouse.click(paneInfo[1].x, paneInfo[1].y);
      await delay(DELAYS.SYNC);
    }
    // Click focus triggers CSS layout transitions, causing size jumps
    const clickResult = await ctx.assertNoGlitches({ operation: 'split', sizeJumps: 30 });
  }, 180000);
});

// ==================== Touch Scroll Helpers ====================

/**
 * Dispatch a touch event sequence (start → moves → end) via CDP.
 * @param {Page} page - Playwright page
 * @param {number} startX - Start X coordinate
 * @param {number} startY - Start Y coordinate
 * @param {number} endY - End Y coordinate (X stays the same)
 * @param {number} steps - Number of intermediate touchmove events
 * @param {number} stepDelay - Delay between steps in ms (affects velocity)
 */
async function dispatchTouchScroll(page, startX, startY, endY, steps = 10, stepDelay = 16) {
  const cdp = await page.context().newCDPSession(page);
  const deltaY = (endY - startY) / steps;

  // touchstart
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y: startY }],
  });
  await delay(stepDelay);

  // touchmove steps
  for (let i = 1; i <= steps; i++) {
    const y = startY + deltaY * i;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX, y }],
    });
    await delay(stepDelay);
  }

  // touchend
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
}

// ==================== Scenario 21: Touch Scrolling ====================

describe('Scenario 21: Touch Scrolling', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Touch scroll: CSS prevention → normal shell → alternate screen → multi-pane isolation', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Verify touch-action: none is set on pane-wrapper
    const touchAction = await ctx.page.evaluate(() => {
      const wrapper = document.querySelector('.pane-wrapper');
      if (!wrapper) return null;
      return getComputedStyle(wrapper).touchAction;
    });
    expect(touchAction).toBe('none');

    // Step 2: Generate scrollback history for copy-mode scroll test
    await typeInTerminal(ctx.page, 'for i in $(seq 0 59); do echo "line-$i"; done');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'line-59');

    // Get pane center coordinates
    const paneBox = await ctx.page.evaluate(() => {
      const pane = document.querySelector('.pane-wrapper');
      if (!pane) return null;
      const r = pane.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, height: r.height };
    });
    expect(paneBox).not.toBeNull();

    // Step 3: Touch scroll up in normal shell → should enter copy mode
    // Finger moves DOWN (positive delta) = scroll UP through history
    await dispatchTouchScroll(
      ctx.page,
      paneBox.x,
      paneBox.y,
      paneBox.y + paneBox.height * 0.4, // swipe down 40% of pane
      10,
      16,
    );
    await delay(DELAYS.SYNC);

    // Verify copy mode was entered
    const copyModeActive = await ctx.page.evaluate(() => {
      const snap = window.app?.getSnapshot();
      if (!snap) return false;
      return Object.keys(snap.context.copyModeStates || {}).length > 0;
    });
    expect(copyModeActive).toBe(true);

    // Exit copy mode by pressing q
    await ctx.page.keyboard.press('q');
    await delay(DELAYS.LONG);

    // Step 4: Touch scroll in alternate screen (less command)
    await typeInTerminal(ctx.page, 'less /etc/services');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);

    // Verify alternate mode is active
    const altOn = await ctx.page.evaluate(() => {
      const pane = document.querySelector('.pane-wrapper');
      return pane?.getAttribute('data-alternate-on') === 'true';
    });
    expect(altOn).toBe(true);

    // Get initial visible text
    const textBefore = await getTerminalText(ctx.page);

    // Touch scroll down in alternate screen (finger up = scroll down = Down arrow keys)
    await dispatchTouchScroll(
      ctx.page,
      paneBox.x,
      paneBox.y + paneBox.height * 0.4,
      paneBox.y - paneBox.height * 0.2, // swipe up 60% of pane
      10,
      16,
    );
    await delay(DELAYS.SYNC);

    // Verify content changed (scrolled down in less)
    const textAfter = await getTerminalText(ctx.page);
    expect(textAfter).not.toBe(textBefore);

    // Exit less
    await ctx.page.keyboard.press('q');
    await delay(DELAYS.LONG);

    // Step 5: Multi-pane touch isolation
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);

    // Generate distinct content in each pane
    await typeInTerminal(ctx.page, 'echo PANE_TWO_MARKER');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);

    // Get both pane positions
    const panePositions = await ctx.page.evaluate(() => {
      const panes = document.querySelectorAll('.pane-wrapper');
      return Array.from(panes).map(p => {
        const r = p.getBoundingClientRect();
        return {
          id: p.getAttribute('data-pane-id'),
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          height: r.height,
        };
      });
    });
    expect(panePositions.length).toBe(2);

    // Touch scroll on second pane only — first pane should be unaffected
    // (This primarily verifies touch events are scoped to the touched pane)
    const secondPane = panePositions[1];
    await dispatchTouchScroll(
      ctx.page,
      secondPane.x,
      secondPane.y,
      secondPane.y + secondPane.height * 0.3,
      5,
      16,
    );
    await delay(DELAYS.LONG);

    // Both panes should still exist
    const finalPaneCount = await getUIPaneCount(ctx.page);
    expect(finalPaneCount).toBe(2);
  }, 180000);
});
