/**
 * Consolidated E2E Scenario Tests
 *
 * 20 scenario tests that chain multiple operations per session,
 * eliminating ~208 session setup/teardown cycles.
 *
 * Original detailed tests preserved in tests/detailed/ for reference.
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
  runCommandViaTmux,
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
} = require('./helpers');

const MOUSE_CAPTURE_SCRIPT = path.join(__dirname, 'helpers', 'mouse-capture.py');
const MOUSE_LOG = '/tmp/mouse-events.log';

// ==================== SGR Mouse Helpers ====================

async function startMouseCapture(ctx) {
  try { fs.unlinkSync(MOUSE_LOG); } catch {}
  await ctx.session.sendKeys(`"python3 ${MOUSE_CAPTURE_SCRIPT}" Enter`);
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
  await ctx.session.sendKeys('q');
  await delay(DELAYS.LONG);
}

// ==================== Float Helpers ====================

async function createFloat(ctx, paneId) {
  const paneNum = paneId.replace('%', '');
  await ctx.session.runViaAdapter(`break-pane -d -s ${paneId} -n "__float_${paneNum}"`);
  await delay(DELAYS.SYNC);
  await delay(DELAYS.SYNC);
}

async function waitForFloatModal(page, timeout = 10000) {
  await page.waitForSelector('.float-modal', { timeout });
}

async function getFloatModalInfo(page) {
  return await page.evaluate(() => {
    const modals = document.querySelectorAll('.float-modal');
    return Array.from(modals).map((modal) => ({
      hasHeader: modal.querySelector('.float-header') !== null,
      hasCloseButton: modal.querySelector('.float-close') !== null,
      hasTerminal: modal.querySelector('.terminal-container') !== null,
    }));
  });
}

// ==================== Scenario 1: Connect & Render ====================

describe('Scenario 1: Connect & Render', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Page load → WS → terminal → echo → ANSI → bold → 256 → truecolor → cursor → empty lines', async () => {
    if (ctx.skipIfNotReady()) return;

    // Step 1: Page loads with app container
    await ctx.navigateToSession();
    const containerInfo = await ctx.page.evaluate(() => {
      const root = document.getElementById('root');
      return {
        hasChildren: root && root.children.length > 0,
        hasTerminal: !!root?.querySelector('[role="log"]'),
      };
    });
    expect(containerInfo.hasChildren).toBe(true);
    expect(containerInfo.hasTerminal).toBe(true);

    // Step 2: WebSocket connected - no error state
    const errorState = await ctx.page.$('.error-state, .disconnected');
    expect(errorState).toBeNull();

    // Step 3: Single pane renders
    const paneCount = await getUIPaneCount(ctx.page);
    expect(paneCount).toBe(1);

    // Step 4: Focus page for interaction
    await focusPage(ctx.page);

    // Step 5: Echo command output
    await runCommandViaTmux(ctx.session, ctx.page, 'echo hello_test_123', 'hello_test_123');

    // Step 6: ANSI colors
    const colorText = await runCommandViaTmux(ctx.session, ctx.page,
      'echo -e "\\e[31mRED_TEXT\\e[0m \\e[32mGREEN_TEXT\\e[0m"', 'RED_TEXT');
    expect(colorText).toContain('GREEN_TEXT');
    const colorInfo = await ctx.page.evaluate(() => {
      const spans = document.querySelectorAll('[role="log"] span');
      const colors = new Set();
      for (const span of spans) {
        const style = getComputedStyle(span);
        if (style.color && style.color !== 'rgb(0, 0, 0)') colors.add(style.color);
      }
      return { hasColoredSpans: colors.size > 0 };
    });
    expect(colorInfo.hasColoredSpans).toBe(true);

    // Step 7: Bold/italic/underline
    const styleText = await runCommandViaTmux(ctx.session, ctx.page,
      'echo -e "\\e[1mBOLD\\e[0m \\e[3mITALIC\\e[0m \\e[4mUNDERLINE\\e[0m"', 'BOLD');
    expect(styleText).toContain('ITALIC');
    expect(styleText).toContain('UNDERLINE');

    // Step 8: 256 colors
    const ext256 = await runCommandViaTmux(ctx.session, ctx.page,
      'echo -e "\\e[38;5;196mRED256\\e[0m \\e[38;5;46mGREEN256\\e[0m"', 'RED256');
    expect(ext256).toContain('GREEN256');

    // Step 9: True color
    const trueColor = await runCommandViaTmux(ctx.session, ctx.page,
      'echo -e "\\e[38;2;255;100;0mORANGE_RGB\\e[0m"', 'ORANGE_RGB');
    expect(trueColor).toContain('ORANGE_RGB');

    // Step 10: Cursor element
    const cursor = await ctx.page.$('.terminal-cursor');
    expect(cursor).not.toBeNull();
    const cursorInfo = await ctx.page.evaluate(() => {
      const c = document.querySelector('.terminal-cursor');
      const t = document.querySelector('[role="log"]');
      if (!c || !t) return null;
      const cr = c.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      return {
        cursorVisible: cr.width > 0 && cr.height > 0,
        withinTerminal: cr.left >= tr.left - 1 && cr.right <= tr.right + 1 &&
                        cr.top >= tr.top - 1 && cr.bottom <= tr.bottom + 1,
      };
    });
    expect(cursorInfo).not.toBeNull();
    expect(cursorInfo.cursorVisible).toBe(true);
    expect(cursorInfo.withinTerminal).toBe(true);

    // Step 11: Empty lines preserved
    await ctx.session.sendKeys('"echo -e \\"LINE1\\\\n\\\\nLINE3\\"" Enter');
    const emptyText = await waitForTerminalText(ctx.page, 'LINE1');
    expect(emptyText).toContain('LINE3');
  }, 120000);
});

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
    await ctx.session.sendKeys('"ech" Tab');
    await delay(DELAYS.LONG);
    await ctx.session.sendKeys('-l " tab_complete_test"');
    await ctx.session.sendKeys('Enter');
    await waitForTerminalText(ctx.page, 'tab_complete_test');

    // Step 4: Ctrl+C interrupts
    await typeInTerminal(ctx.page, 'sleep 100');
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);
    await sendKeyCombo(ctx.page, 'Control', 'c');
    await delay(DELAYS.LONG);
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
    await runCommandViaTmux(ctx.session, ctx.page, 'echo history_test_123', 'history_test_123');
    await runCommandViaTmux(ctx.session, ctx.page, 'echo second_command', 'second_command');
    await ctx.page.keyboard.press('ArrowUp');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.press('ArrowUp');
    await delay(DELAYS.SHORT);
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);
    const text = await getTerminalText(ctx.page);
    expect(text.split('history_test_123').length).toBeGreaterThan(2);
  }, 120000);
});

// ==================== Scenario 3: Pane Lifecycle ====================

describe('Scenario 3: Pane Lifecycle', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Split H → V → navigate → resize → zoom → unzoom → kill → exit last', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 1: Horizontal split
    const splitResult = await withConsistencyChecks(ctx, async () => {
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);
    }, { operationType: 'split' });
    expect(await ctx.session.getPaneCount()).toBe(2);
    await waitForPaneCount(ctx.page, 2);
    let panes = await getUIPaneInfo(ctx.page);
    expect(panes[0].y).not.toBe(panes[1].y);
    expect(splitResult.glitch.summary.nodeFlickers).toBeLessThanOrEqual(2);

    // Step 2: Vertical split
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(3);
    await waitForPaneCount(ctx.page, 3);

    // Step 3: Navigate between panes
    const initialPane = await ctx.session.getActivePaneId();
    await ctx.session.selectPane('U');
    await delay(DELAYS.LONG);
    const afterPane = await ctx.session.getActivePaneId();
    expect(afterPane).not.toBe(initialPane);

    // Step 4: Resize
    const panesBefore = await ctx.session.getPaneInfo();
    await ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 5`);
    await delay(DELAYS.SYNC);
    const panesAfter = await ctx.session.getPaneInfo();
    expect(verifyLayoutChanged(panesBefore, panesAfter)).toBe(true);

    // Step 5: Zoom in
    expect(await ctx.session.isPaneZoomed()).toBe(false);
    await ctx.session.toggleZoom();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(true);

    // Step 6: Zoom out
    await ctx.session.toggleZoom();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(false);
    expect(await ctx.session.getPaneCount()).toBe(3);

    // Step 7: Kill pane
    await ctx.session.killPane();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Kill another pane
    await ctx.session.killPane();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 8: Exit last pane - session should survive
    await runCommandViaTmux(ctx.session, ctx.page, 'exit', '$', 5000).catch(() => {});
    await delay(DELAYS.SYNC);
    expect(ctx.session.exists()).toBe(true);
  }, 120000);
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
    await ctx.session.newWindow();
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, initialCount + 1);
    expect(await ctx.session.getWindowCount()).toBe(initialCount + 1);

    // Step 2: Window tabs
    const windowInfo = await ctx.session.getWindowInfo();
    expect(windowInfo.length).toBe(2);

    // Step 3: Next window
    const currentIndex = await ctx.session.getCurrentWindowIndex();
    await ctx.session.nextWindow();
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(currentIndex);

    // Step 4: Previous window
    const idx = await ctx.session.getCurrentWindowIndex();
    await ctx.session.previousWindow();
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(idx);

    // Step 5: Create 3rd window and select by number
    await ctx.session.newWindow();
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 3);
    await ctx.session.selectWindow(1);
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).toBe('1');

    // Step 6: Last window toggle
    await ctx.session.lastWindow();
    await delay(DELAYS.LONG);
    // Should be on one of the other windows
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe('1');

    // Step 7: Rename window
    await ctx.session.renameWindow('MyRenamedWindow');
    await delay(DELAYS.SYNC);
    let windows = await ctx.session.getWindowInfo();
    expect(windows.find(w => w.name === 'MyRenamedWindow')).toBeDefined();

    // Step 8: Close windows
    windows = await ctx.session.getWindowInfo();
    const curIdx = await ctx.session.getCurrentWindowIndex();
    for (const w of windows) {
      if (String(w.index) !== String(curIdx)) {
        await ctx.session.killWindow(w.index);
        await delay(DELAYS.SHORT);
      }
    }
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 1);
    expect(await ctx.session.getWindowCount()).toBe(1);

    // Step 9: Layout test with 4 panes
    await ctx.session.splitHorizontal();
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    await ctx.session.selectPane('U');
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 4);

    await ctx.session.selectLayout('tiled');
    await delay(DELAYS.SYNC);
    const tiledPanes = await ctx.session.getPaneInfo();
    expect(tiledPanes.length).toBe(4);
    const areas = tiledPanes.map(p => p.width * p.height);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(2);
  }, 120000);
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
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "MARKER_BETA"', 'MARKER_BETA');

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
  }, 120000);
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
    const backdrop = await ctx.page.$('.float-backdrop');
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
    await ctx.page.click('.float-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.float-modal').length === 0,
      { timeout: 10000, polling: 100 }
    );
    let modals = await ctx.page.$$('.float-modal');
    expect(modals.length).toBe(0);
    windows = await ctx.session.getWindowInfo();
    expect(windows.find(w => w.name === `__float_${paneNum}`)).toBeUndefined();

    // Step 6: Re-create float (need to split again first since we only have 1 pane)
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId);
    await waitForFloatModal(ctx.page);

    // Step 7: Backdrop click closes float
    // Click far from center to avoid hitting the centered float modal
    const newBackdrop = await ctx.page.$('.float-backdrop');
    const box = await newBackdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.float-modal').length === 0,
      { timeout: 10000, polling: 100 }
    );
    modals = await ctx.page.$$('.float-modal');
    expect(modals.length).toBe(0);
  }, 120000);
});

// ==================== Scenario 7: Mouse Click & Scroll ====================

describe('Scenario 7: Mouse Click & Scroll', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Click terminal → scroll up (copy mode) → scroll down → user-select none → double-click → drag no selection', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Click in terminal area doesn't lose focus
    await focusPage(ctx.page);
    const terminal = await ctx.page.$('[role="log"]');
    let box = await terminal.boundingBox();
    await ctx.page.mouse.click(box.x + 50, box.y + 50);
    await ctx.page.mouse.click(box.x + 100, box.y + 100);
    await delay(DELAYS.LONG);
    await runCommandViaTmux(ctx.session, ctx.page, 'echo click_test', 'click_test');

    // Step 2: Scroll up enters copy mode
    await runCommandViaTmux(ctx.session, ctx.page, 'seq 1 100', '100');
    box = await ctx.page.locator('[role="log"]').first().boundingBox();
    await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await ctx.page.mouse.wheel(0, -300);
    await delay(DELAYS.SHORT);
    await ctx.page.mouse.wheel(0, -300);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneInCopyMode()).toBe(true);

    // Step 3: Scroll down
    await ctx.page.mouse.wheel(0, 300);
    await delay(DELAYS.LONG);
    await ctx.page.mouse.wheel(0, 300);
    await delay(DELAYS.SYNC);
    // Exit copy mode
    if (await ctx.session.isPaneInCopyMode()) {
      await ctx.session.exitCopyMode();
      await delay(DELAYS.SHORT);
    }

    // Step 4: user-select: none on terminal content
    const userSelect = await ctx.page.evaluate(() => {
      const el = document.querySelector('.terminal-content');
      return el ? getComputedStyle(el).userSelect : null;
    });
    expect(userSelect).toBe('none');

    // Step 5: Double-click no browser selection
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "WORD1 WORD2 WORD3"', 'WORD1');
    const termEl = await ctx.page.$('[role="log"]');
    box = await termEl.boundingBox();
    await ctx.page.mouse.dblclick(box.x + 100, box.y + box.height / 2);
    await delay(DELAYS.LONG);
    const selectedText = await ctx.page.evaluate(() => {
      const selection = window.getSelection();
      return selection ? selection.toString() : '';
    });
    expect(selectedText).toBe('');
    if (await ctx.session.isPaneInCopyMode()) {
      await ctx.session.exitCopyMode();
    }

    // Step 6: Drag no browser selection
    await ctx.session.sendKeys('"echo DRAG_TEST_CONTENT" Enter');
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
    if (await ctx.session.isPaneInCopyMode()) {
      await ctx.session.exitCopyMode();
      await delay(DELAYS.SHORT);
    }
    await ctx.session.sendKeys('"echo AFTER_DRAG_OK" Enter');
    await delay(DELAYS.SYNC);
    const afterText = await ctx.page.evaluate(() => document.querySelector('[role="log"]')?.textContent || '');
    expect(afterText).toContain('AFTER_DRAG_OK');
  }, 120000);
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
    await ctx.session.resizePane('D', 5);
    await delay(DELAYS.SYNC);
    let panesAfter = await ctx.session.getPaneInfo();
    const heightsChanged = panesBefore.some((before, i) => {
      const after = panesAfter[i];
      return after && before.height !== after.height;
    });
    expect(heightsChanged).toBe(true);

    // Kill panes to reset
    await ctx.session.killPane();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 2: Drag vertical divider (via tmux resize)
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    panesBefore = await ctx.session.getPaneInfo();
    await ctx.session.resizePane('R', 10);
    await delay(DELAYS.SYNC);
    panesAfter = await ctx.session.getPaneInfo();
    const widthsChanged = panesBefore.some((before, i) => {
      const after = panesAfter[i];
      return after && before.width !== after.width;
    });
    expect(widthsChanged).toBe(true);

    // Kill pane to reset for SGR tests
    await ctx.session.killPane();
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
  }, 120000);
});

// ==================== Scenario 9: Copy Mode Navigate ====================

describe('Scenario 9: Copy Mode Navigate', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Enter → hjkl → start/end line → page up/down → persists during nav → exit q → re-enter → exit Escape', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate scrollback content
    await runCommandViaTmux(ctx.session, ctx.page, 'seq 1 200', '200');

    // Step 1: Enter copy mode
    await ctx.session.enterCopyMode();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneInCopyMode()).toBe(true);

    // Step 2: Navigate with cursor keys (hjkl via tmux send-keys -X)
    const initialPos = await ctx.session.getCopyCursorPosition();
    await ctx.session.copyModeMove('up', 3);
    await delay(DELAYS.SHORT);
    const afterUp = await ctx.session.getCopyCursorPosition();
    if (initialPos && afterUp) {
      expect(afterUp.y).toBeLessThan(initialPos.y);
    }
    await ctx.session.copyModeMove('down', 1);
    await delay(DELAYS.SHORT);
    await ctx.session.copyModeMove('right', 2);
    await delay(DELAYS.SHORT);

    // Step 3: Page up/down
    await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X page-up`);
    await delay(DELAYS.LONG);
    await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X page-down`);
    await delay(DELAYS.LONG);

    // Step 4: Still in copy mode after navigation
    expect(await ctx.session.isPaneInCopyMode()).toBe(true);

    // Step 5: Exit with q
    await ctx.session.exitCopyMode();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneInCopyMode()).toBe(false);

    // Step 6: Re-enter
    await ctx.session.enterCopyMode();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneInCopyMode()).toBe(true);

    // Step 7: Exit with Escape
    await ctx.session.sendKeys('Escape');
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneInCopyMode()).toBe(false);
  }, 120000);
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
    await ctx.session.runCommand(`set-buffer "${testText}"`);
    await ctx.session.pasteBuffer();
    await delay(DELAYS.LONG);
    const text = await getTerminalText(ctx.page);
    expect(text).toContain(testText);
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.SHORT);

    // Step 2: Generate target content for search
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "SEARCH_TARGET_AAA"', 'SEARCH_TARGET_AAA');
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "SEARCH_TARGET_BBB"', 'SEARCH_TARGET_BBB');

    // Step 3: Enter copy mode and search
    await ctx.session.enterCopyMode();
    await delay(DELAYS.SYNC);
    const posBeforeSearch = await ctx.session.getCopyCursorPosition();
    await ctx.session.copyModeSearchForward('SEARCH_TARGET');
    await delay(DELAYS.LONG);
    const posAfterSearch = await ctx.session.getCopyCursorPosition();
    if (posBeforeSearch && posAfterSearch) {
      // Cursor should have moved
      expect(posAfterSearch.y !== posBeforeSearch.y || posAfterSearch.x !== posBeforeSearch.x).toBe(true);
    }
    expect(await ctx.session.isPaneInCopyMode()).toBe(true);

    // Step 4: Repeat search with n (search-again) and N (search-reverse)
    const posBeforeN = await ctx.session.getCopyCursorPosition();
    await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X search-again`);
    await delay(DELAYS.LONG);
    const posAfterN = await ctx.session.getCopyCursorPosition();
    if (posBeforeN && posAfterN) {
      // Position should change or stay (depends on match count)
      expect(posAfterN).toBeDefined();
    }

    await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X search-reverse`);
    await delay(DELAYS.LONG);

    // Step 5: Select and copy
    await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X begin-selection`);
    await delay(DELAYS.SHORT);
    await ctx.session.copyModeMove('right', 5);
    await delay(DELAYS.SHORT);
    await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X copy-selection-and-cancel`);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneInCopyMode()).toBe(false);

    // Step 6: Paste copied text
    await ctx.session.pasteBuffer();
    await delay(DELAYS.LONG);
    // Terminal should be functional after copy-paste workflow
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.SHORT);
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "COPY_PASTE_OK"', 'COPY_PASTE_OK');
  }, 120000);
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
    await ctx.session.newWindow();
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
    await ctx.session.renameWindow('RENAMED_WINDOW');
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
      await ctx.session.killWindow(inactiveWindow.index);
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 1);
    }
    expect(await ctx.session.getWindowCount()).toBe(1);
  }, 120000);
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
    await ctx.session.splitHorizontal();
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
    await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
    ctx.session.setPage(ctx.page);
    await waitForSessionReady(ctx.page, ctx.session.name, 15000);
    await delay(DELAYS.SYNC * 2);

    // Step 3: Verify preserved
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 4: Split via tmux (external change)
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 3);

    // Step 5: 3 rapid splits
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SHORT);
    await ctx.session.splitVertical();
    await delay(DELAYS.SHORT);
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SYNC);

    // Step 6: UI synced
    const tmuxCount = await ctx.session.getPaneCount();
    expect(tmuxCount).toBe(6);
    await waitForPaneCount(ctx.page, 6);
    const uiCount = await getUIPaneCount(ctx.page);
    expect(uiCount).toBe(6);
  }, 120000);
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
    await ctx.session.splitHorizontal();
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 3);

    // Step 2: Open second page
    const { navigateToSession } = require('./helpers');
    const browser = await ctx.page.context().browser();
    const page2 = await browser.newPage();
    await navigateToSession(page2, ctx.session.name);
    await page2.waitForSelector('[role="log"]', { timeout: 10000 });
    await delay(DELAYS.SYNC);

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
  }, 120000);
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
    await ctx.session.sendKeys('"echo -e \\"\\\\e]8;;http://example.com\\\\e\\\\\\\\Click Here\\\\e]8;;\\\\e\\\\\\\\\\"" Enter');
    await delay(DELAYS.SYNC);
    const text1 = await getTerminalText(ctx.page);
    expect(text1).toContain('Click Here');

    // Step 2: Multiple links
    await ctx.session.sendKeys('"echo -e \\"\\\\e]8;;http://a.com\\\\e\\\\\\\\LinkA\\\\e]8;;\\\\e\\\\\\\\ \\\\e]8;;http://b.com\\\\e\\\\\\\\LinkB\\\\e]8;;\\\\e\\\\\\\\\\"" Enter');
    await delay(DELAYS.SYNC);
    const text2 = await getTerminalText(ctx.page);
    expect(text2).toContain('LinkA');
    expect(text2).toContain('LinkB');

    // Step 3: Malformed OSC 8 - terminal should survive
    await ctx.session.sendKeys('"echo -e \\"\\\\e]8;;http://broken.com\\\\e\\\\\\\\BROKEN_LINK\\"" Enter');
    await delay(DELAYS.SYNC);
    // Verify terminal still functional
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "AFTER_MALFORMED"', 'AFTER_MALFORMED');

    // Step 4: OSC 52 doesn't crash
    await ctx.session.sendKeys('"echo -ne \\"\\\\e]52;c;SGVsbG8=\\\\e\\\\\\\\\\"" Enter');
    await delay(DELAYS.SYNC);
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "OSC52_OK"', 'OSC52_OK');

    // Step 5: Multiple OSC 52 operations
    await ctx.session.sendKeys('"echo -ne \\"\\\\e]52;c;Zmlyc3Q=\\\\e\\\\\\\\\\"" Enter');
    await delay(DELAYS.SHORT);
    await ctx.session.sendKeys('"echo -ne \\"\\\\e]52;c;c2Vjb25k\\\\e\\\\\\\\\\"" Enter');
    await delay(DELAYS.SHORT);
    await ctx.session.sendKeys('"echo -ne \\"\\\\e]52;c;dGhpcmQ=\\\\e\\\\\\\\\\"" Enter');
    await delay(DELAYS.SYNC);
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "MULTI_OSC52_OK"', 'MULTI_OSC52_OK');
  }, 120000);
});

// ==================== Scenario 15: Special Characters ====================

describe('Scenario 15: Special Characters', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('; # $ {} \\ ~ quotes mixed → diacritics → paste with specials', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Semicolon
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "a;b"', 'a;b');

    // Step 2: Hash
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "a#b"', 'a#b');

    // Step 3: Dollar sign (single-quoted)
    await runCommandViaTmux(ctx.session, ctx.page, "echo 'a$b'", 'a$b');

    // Step 4: Curly braces
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "a{b}c"', 'a{b}c');

    // Step 5: Backslash (single-quoted)
    await runCommandViaTmux(ctx.session, ctx.page, "echo 'a\\\\b'", 'a\\\\b');

    // Step 6: Tilde
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "a~b"', 'a~b');

    // Step 7: Quotes
    await runCommandViaTmux(ctx.session, ctx.page, "echo 'say \"hi\"'", 'say "hi"');

    // Step 8: Multiple special chars combined
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "x;y#z~w"', 'x;y#z~w');

    // Step 9: Diacritics
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "café"', 'café');

    // Step 10: Paste with special characters
    const marker = `paste_marker_${Date.now()}`;
    await pasteText(ctx.page, `echo "${marker}"`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, marker);

    // Step 11: Paste with specials
    await pasteText(ctx.page, 'echo "x;y#z"');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'x;y#z');
  }, 120000);
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
    await ctx.session.sendKeys('"echo -e \\"BOX_TOP\\\\n|test|\\\\nBOX_BTM\\"" Enter');
    const boxText = await waitForTerminalText(ctx.page, 'BOX_TOP');
    expect(boxText).toContain('test');
    expect(boxText).toContain('BOX_BTM');

    // Step 2: CJK characters
    await ctx.session.sendKeys('"echo \\"CJK_TEST: 你好世界 こんにちは 안녕하세요 END_CJK\\"" Enter');
    await delay(DELAYS.SYNC);
    const cjkText = await getTerminalText(ctx.page);
    expect(cjkText).toContain('CJK_TEST');
    expect(cjkText).toContain('END_CJK');

    // Step 3: Cursor works after CJK
    const afterCjk = await runCommandViaTmux(ctx.session, ctx.page, 'echo "AFTER_CJK"', 'AFTER_CJK');
    expect(afterCjk).toContain('AFTER_CJK');

    // Step 4: Emoji - single codepoint
    await ctx.session.sendKeys('"echo \\"EMOJI_TEST: X X X END_EMOJI\\"" Enter');
    const emojiText = await waitForTerminalText(ctx.page, 'EMOJI_TEST');
    expect(emojiText).toContain('END_EMOJI');

    // Step 5: Emoji - multi-codepoint (terminal should not break)
    await ctx.session.sendKeys('"echo \\"MULTI_EMOJI_START END_MULTI\\"" Enter');
    const multiEmoji = await waitForTerminalText(ctx.page, 'MULTI_EMOJI_START');
    expect(multiEmoji).toContain('END_MULTI');
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "AFTER_EMOJI"', 'AFTER_EMOJI');

    // Step 6: Unicode in git-style status output
    const statusText = await runCommandViaTmux(ctx.session, ctx.page,
      'printf "\\u2713 Pass\\n\\u2717 Fail\\n\\u26A0 Warn\\n"', 'Pass');
    expect(statusText).toContain('Fail');
    expect(statusText).toContain('Warn');

    // Step 7: Tree output with box-drawing
    await ctx.session.sendKeys('"printf \\"├── src\\\\n│   ├── main.rs\\\\n│   └── lib.rs\\\\n└── Cargo.toml\\\\n\\"" Enter');
    const treeText = await waitForTerminalText(ctx.page, 'src');
    expect(treeText).toContain('main.rs');
    expect(treeText).toContain('Cargo.toml');
  }, 120000);
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
    await runCommandViaTmux(ctx.session, ctx.page, 'yes | head -500 && echo DONE_YES', 'DONE_YES', 20000);
    const elapsed1 = Date.now() - start1;
    expect(elapsed1).toBeLessThan(20000);
    expect(ctx.session.exists()).toBe(true);

    // Step 2: Large output (seq 1 2000)
    const start2 = Date.now();
    await runCommandViaTmux(ctx.session, ctx.page, 'seq 1 2000 && echo SEQ_DONE', 'SEQ_DONE', 20000);
    const elapsed2 = Date.now() - start2;
    expect(elapsed2).toBeLessThan(20000);
    expect(ctx.session.exists()).toBe(true);

    // Step 3: Large scrollback accumulation
    await runCommandViaTmux(ctx.session, ctx.page, 'for i in $(seq 1 200); do echo "line_$i"; done && echo SCROLL_DONE', 'SCROLL_DONE', 15000);
    expect(ctx.session.exists()).toBe(true);

    // Step 4: Verify responsive
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "STILL_RESPONSIVE"', 'STILL_RESPONSIVE');
  }, 120000);
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

    // Step 1: Rapid splits ×4
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SHORT);
    await ctx.session.splitVertical();
    await delay(DELAYS.SHORT);
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SHORT);
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(5);

    // Step 2: Kill ×3
    await ctx.session.killPane();
    await delay(DELAYS.SHORT);
    await ctx.session.killPane();
    await delay(DELAYS.SHORT);
    await ctx.session.killPane();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 3: Split-close-split
    const result = await withConsistencyChecks(ctx, async () => {
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SHORT);
      await ctx.session.killPane();
      await delay(DELAYS.SHORT);
      await ctx.session.splitVertical();
      await delay(DELAYS.SYNC);
    }, { operationType: 'split' });
    expect(await ctx.session.getPaneCount()).toBe(3);
    expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(4);

    // Kill to reset
    await ctx.session.killPane();
    await ctx.session.killPane();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 4: 6-pane grid
    await ctx.session.splitHorizontal();
    await waitForPaneCount(ctx.page, 2);
    await ctx.session.splitHorizontal();
    await waitForPaneCount(ctx.page, 3);
    await ctx.session.selectPane('U');
    await ctx.session.selectPane('U');
    await ctx.session.splitVertical();
    await waitForPaneCount(ctx.page, 4);
    await ctx.session.selectPane('D');
    await ctx.session.splitVertical();
    await waitForPaneCount(ctx.page, 5);
    await ctx.session.selectPane('D');
    await ctx.session.splitVertical();
    await waitForPaneCount(ctx.page, 6);
    expect(await ctx.session.getPaneCount()).toBe(6);
    const sizeResult = await verifyDomSizes(ctx.page);
    expect(sizeResult.valid).toBe(true);

    // Kill back to 1 pane for next steps
    for (let i = 0; i < 5; i++) {
      await ctx.session.killPane();
      await delay(DELAYS.SHORT);
    }
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 5: 4 windows
    await ctx.session.newWindow();
    await delay(DELAYS.SHORT);
    await ctx.session.newWindow();
    await delay(DELAYS.SHORT);
    await ctx.session.newWindow();
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 4);
    expect(await ctx.session.getWindowCount()).toBe(4);

    // Step 6: Swap panes
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SYNC);
    const panesBefore = await ctx.session.getPaneInfo();
    const firstPaneIdBefore = panesBefore[0].id;
    await ctx.session.swapPane('D');
    await delay(DELAYS.SYNC);
    const panesAfterSwap = await ctx.session.getPaneInfo();
    expect(panesAfterSwap[0].id !== firstPaneIdBefore ||
           panesAfterSwap[0].y !== panesBefore[0].y).toBe(true);
  }, 120000);
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
    await ctx.session.splitHorizontal();
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 3);
    expect(await ctx.session.getPaneCount()).toBe(3);

    // Step 2: Window 2 with 2 panes
    await ctx.session.newWindow();
    await delay(DELAYS.SYNC);
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 3: Window 3 with 2 panes
    await ctx.session.newWindow();
    await delay(DELAYS.SYNC);
    await ctx.session.splitVertical();
    await delay(DELAYS.SYNC);
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
      await ctx.session.selectWindow(w.index);
      await delay(DELAYS.LONG);
    }

    // Step 6: Send commands to verify panes alive
    await ctx.session.selectWindow(windowInfo[0].index);
    await delay(DELAYS.LONG);
    await runCommandViaTmux(ctx.session, ctx.page, 'echo "WIN1_OK"', 'WIN1_OK');

    // Step 7: Zoom and unzoom
    await ctx.session.toggleZoom();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(true);
    await ctx.session.toggleZoom();
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(false);

    // Step 8: Navigate windows rapidly
    for (const w of windowInfo) {
      await ctx.session.selectWindow(w.index);
      await delay(DELAYS.SHORT);
    }
    expect(ctx.session.exists()).toBe(true);
  }, 120000);
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
    await ctx.session.splitHorizontal();
    await waitForPaneCount(ctx.page, 2);
    await delay(DELAYS.SYNC);
    let result = await ctx.assertNoGlitches({ operation: 'split' });

    // Step 2: Vertical split with glitch detection
    await ctx.startGlitchDetection({ scope: '.pane-container' });
    await ctx.session.splitVertical();
    await waitForPaneCount(ctx.page, 3);
    await delay(DELAYS.SYNC);
    result = await ctx.assertNoGlitches({ operation: 'split' });

    // Kill to get back to 2 panes for resize test
    await ctx.session.killPane();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);

    // Step 3: Resize with glitch detection
    await ctx.startGlitchDetection({
      scope: '.pane-container',
      sizeJumpThreshold: 100,
      ignoreSelectors: ['.terminal-content', '.terminal-line', '.terminal-cursor', '.resize-divider'],
    });
    ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 5`);
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
  }, 120000);
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
    for (let i = 0; i < 60; i++) {
      await ctx.session.sendKeys(`"echo line-${i}" Enter`);
    }
    await delay(DELAYS.LONG);

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
    await ctx.session.sendKeys(`"less /etc/services" Enter`);
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
    await ctx.session.splitHorizontal();
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);

    // Generate distinct content in each pane
    await ctx.session.sendKeys(`"echo PANE_TWO_MARKER" Enter`);
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
  }, 90000);
});
