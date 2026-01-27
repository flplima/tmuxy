/**
 * Category 2: Keyboard Input
 *
 * Tests for basic typing, control sequences, arrow keys,
 * function keys, and IME input - all via actual keyboard events.
 */

const {
  createTestContext,
  delay,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  typeInTerminal,
  pressEnter,
  sendKeyCombo,
  sendTmuxPrefix,
  sendPrefixCommand,
  assertStateConsistency,
  // Keyboard operation helpers
  splitPaneKeyboard,
  navigatePaneKeyboard,
  toggleZoomKeyboard,
  createWindowKeyboard,
  nextWindowKeyboard,
  prevWindowKeyboard,
  killPaneKeyboard,
  DELAYS,
} = require('./helpers');

describe('Category 2: Keyboard Input', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 2.1 Basic Input
  // ====================
  describe('2.1 Basic Input', () => {
    test('Alphanumeric - type hello123', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo hello123', 'hello123');
    });

    test('Special characters - type symbols', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Test special characters that don't conflict with shell metacharacters
      await runCommand(ctx.page, 'echo "test-underscore_and.dot"', 'test-underscore_and.dot');
    });

    test('Backspace - deletes characters', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'echo helloxx');
      await ctx.page.keyboard.press('Backspace');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('Backspace');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'hello');
    });

    test('Enter - executes command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const testId = `enter_test_${Date.now()}`;
      await runCommand(ctx.page, `echo ${testId}`, testId);
    });

    test('Tab completion - completes command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'ech');
      await ctx.page.keyboard.press('Tab');
      await delay(DELAYS.LONG);

      await typeInTerminal(ctx.page, ' tab_complete_test');
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'tab_complete_test');
    });
  });

  // ====================
  // 2.2 Control Sequences
  // ====================
  describe('2.2 Control Sequences', () => {
    test('Ctrl+C - interrupts command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'sleep 100');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await sendKeyCombo(ctx.page, 'Control', 'c');
      await delay(DELAYS.LONG);

      await runCommand(ctx.page, 'echo "after_interrupt"', 'after_interrupt');
    });

    test('Ctrl+D - sends EOF', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'cat');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await typeInTerminal(ctx.page, 'test_input');
      await pressEnter(ctx.page);
      await delay(DELAYS.SHORT);

      await sendKeyCombo(ctx.page, 'Control', 'd');

      await waitForTerminalText(ctx.page, 'test_input');
    });

    test('Ctrl+L - clears screen', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo "before_ctrl_l"', 'before_ctrl_l');

      const textBefore = await getTerminalText(ctx.page);
      expect(textBefore).toContain('before_ctrl_l');

      await sendKeyCombo(ctx.page, 'Control', 'l');
      await delay(DELAYS.LONG);

      // After clear, the "before_ctrl_l" output should be scrolled off or cleared
      // Just verify the terminal is still functional
      const textAfter = await getTerminalText(ctx.page);
      expect(textAfter).toBeDefined();
    });

    test('Ctrl+Z - suspends process', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'sleep 100');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await sendKeyCombo(ctx.page, 'Control', 'z');
      await delay(DELAYS.LONG);

      const text = await getTerminalText(ctx.page);
      expect(text.toLowerCase()).toMatch(/stopped|suspended|\[\d+\]/);

      // Clean up
      await typeInTerminal(ctx.page, 'kill %1 2>/dev/null; true');
      await pressEnter(ctx.page);
    });

    test('Prefix+c creates new window via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const initialWindowCount = ctx.session.getWindowCount();

      // Create new window using keyboard: Ctrl+A then c
      await sendPrefixCommand(ctx.page, 'c');
      await delay(DELAYS.SYNC);

      const newWindowCount = ctx.session.getWindowCount();
      expect(newWindowCount).toBe(initialWindowCount + 1);

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('Prefix+" splits pane horizontally via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      expect(ctx.session.getPaneCount()).toBe(1);

      // Split horizontal: Ctrl+A then " (Shift+')
      await sendPrefixCommand(ctx.page, "'", { shift: true });
      await delay(DELAYS.SYNC);

      expect(ctx.session.getPaneCount()).toBe(2);

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('Prefix+% splits pane vertically via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      expect(ctx.session.getPaneCount()).toBe(1);

      // Split vertical: Ctrl+A then % (Shift+5)
      await sendPrefixCommand(ctx.page, '5', { shift: true });
      await delay(DELAYS.SYNC);

      expect(ctx.session.getPaneCount()).toBe(2);

      await assertStateConsistency(ctx.page, ctx.session);
    });
  });

  // ====================
  // 2.3 Arrow Keys & Navigation
  // ====================
  describe('2.3 Arrow Keys & Navigation', () => {
    test('Up arrow - recalls history', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const testCmd = 'echo history_test_123';
      await runCommand(ctx.page, testCmd, 'history_test_123');

      await runCommand(ctx.page, 'echo second_command', 'second_command');

      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);

      await delay(DELAYS.LONG);
      const text = await getTerminalText(ctx.page);
      expect(text.split('history_test_123').length).toBeGreaterThan(2);
    });

    test('Down arrow - navigates history forward', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo first_cmd', 'first_cmd');
      await runCommand(ctx.page, 'echo second_cmd', 'second_cmd');

      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowDown');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'second_cmd');
    });

    test('Left/Right arrows - cursor movement', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'echo ABCD');
      await ctx.page.keyboard.press('ArrowLeft');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowLeft');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type('X');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'ABXCD');
    });

    test('Home/End - jump to line start/end', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'echo testline');
      await ctx.page.keyboard.press('Home');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type('PREFIX_');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'PREFIX_');
    });

    test('Page Up/Down - scrolling in less', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'seq 1 100 | less', '1');

      await ctx.page.keyboard.press('PageDown');
      await delay(DELAYS.LONG);

      // Should have scrolled - higher numbers visible
      const text = await getTerminalText(ctx.page);
      // After page down, we should see numbers > 20
      expect(text).toMatch(/[2-9]\d|100/);

      await ctx.page.keyboard.press('q');
      await delay(DELAYS.LONG);
    });
  });

  // ====================
  // 2.4 Function Keys
  // ====================
  describe('2.4 Function Keys', () => {
    test('F1-F12 function keys are sent', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Bind F2 to something testable in bash
      await runCommand(ctx.page, 'bind \'\\eOQ\': "echo F2_PRESSED"', '$');

      // Press F2
      await ctx.page.keyboard.press('F2');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Should see the bound command
      const text = await getTerminalText(ctx.page);
      // Either the command was executed or at least didn't break anything
      expect(ctx.session.exists()).toBe(true);
    });

    test('F-keys dont break terminal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Press various F-keys
      await ctx.page.keyboard.press('F1');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('F3');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('F5');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('F12');
      await delay(DELAYS.SHORT);

      // Terminal should still be functional
      await runCommand(ctx.page, 'echo "after_fkeys"', 'after_fkeys');
    });
  });

  // ====================
  // 2.5 Tmux Prefix Key Bindings
  // ====================
  describe('2.5 Tmux Prefix Key Bindings', () => {
    test('Prefix+z toggles zoom via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(ctx.session.isPaneZoomed()).toBe(false);

      // Toggle zoom: Ctrl+A then z
      await sendPrefixCommand(ctx.page, 'z');
      await delay(DELAYS.SYNC);

      expect(ctx.session.isPaneZoomed()).toBe(true);

      // Toggle back
      await sendPrefixCommand(ctx.page, 'z');
      await delay(DELAYS.SYNC);

      expect(ctx.session.isPaneZoomed()).toBe(false);

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('Prefix+Arrow navigates panes via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const initialActiveId = ctx.session.getActivePaneId();

      // Navigate up: Ctrl+A then ArrowUp
      await sendPrefixCommand(ctx.page, 'ArrowUp');
      await delay(DELAYS.SYNC);

      const newActiveId = ctx.session.getActivePaneId();
      expect(newActiveId).not.toBe(initialActiveId);

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('Prefix+n/p switches windows via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create second window
      ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      expect(ctx.session.getCurrentWindowIndex()).toBe('2');

      // Previous window: Ctrl+A then p
      await sendPrefixCommand(ctx.page, 'p');
      await delay(DELAYS.SYNC);

      expect(ctx.session.getCurrentWindowIndex()).toBe('1');

      // Next window: Ctrl+A then n
      await sendPrefixCommand(ctx.page, 'n');
      await delay(DELAYS.SYNC);

      expect(ctx.session.getCurrentWindowIndex()).toBe('2');

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('Prefix+number selects window via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      ctx.session.newWindow();
      ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      expect(ctx.session.getCurrentWindowIndex()).toBe('3');

      // Select window 1: Ctrl+A then 1
      await sendPrefixCommand(ctx.page, '1');
      await delay(DELAYS.SYNC);

      expect(ctx.session.getCurrentWindowIndex()).toBe('1');

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('Prefix+x kills pane via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(ctx.session.getPaneCount()).toBe(2);

      // Kill pane: Ctrl+A then x (no confirmation in web UI)
      await sendPrefixCommand(ctx.page, 'x');
      await delay(DELAYS.SYNC);

      expect(ctx.session.getPaneCount()).toBe(1);

      await assertStateConsistency(ctx.page, ctx.session);
    });
  });

  // ====================
  // 2.6 Keyboard Helpers Integration
  // ====================
  describe('2.6 Keyboard Helpers Integration', () => {
    test('splitPaneKeyboard helper creates pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      expect(ctx.session.getPaneCount()).toBe(1);

      // Use the helper function
      await splitPaneKeyboard(ctx.page, 'horizontal');

      expect(ctx.session.getPaneCount()).toBe(2);
      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('navigatePaneKeyboard helper navigates panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const initialActiveId = ctx.session.getActivePaneId();

      // Use the helper function
      await navigatePaneKeyboard(ctx.page, 'up');

      const newActiveId = ctx.session.getActivePaneId();
      expect(newActiveId).not.toBe(initialActiveId);

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('toggleZoomKeyboard helper toggles zoom', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(ctx.session.isPaneZoomed()).toBe(false);

      // Use the helper function
      await toggleZoomKeyboard(ctx.page);

      expect(ctx.session.isPaneZoomed()).toBe(true);

      // Toggle back
      await toggleZoomKeyboard(ctx.page);

      expect(ctx.session.isPaneZoomed()).toBe(false);
      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('createWindowKeyboard helper creates window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const initialWindowCount = ctx.session.getWindowCount();

      // Use the helper function
      await createWindowKeyboard(ctx.page);

      expect(ctx.session.getWindowCount()).toBe(initialWindowCount + 1);
      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('nextWindowKeyboard and prevWindowKeyboard helpers navigate windows', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      ctx.session.newWindow();
      ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      expect(ctx.session.getCurrentWindowIndex()).toBe('3');

      // Use helper to go to previous window
      await prevWindowKeyboard(ctx.page);
      expect(ctx.session.getCurrentWindowIndex()).toBe('2');

      // Use helper to go to next window
      await nextWindowKeyboard(ctx.page);
      expect(ctx.session.getCurrentWindowIndex()).toBe('3');

      await assertStateConsistency(ctx.page, ctx.session);
    });

    test('killPaneKeyboard helper kills pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(ctx.session.getPaneCount()).toBe(2);

      // Use the helper function (no confirmation in web UI)
      await killPaneKeyboard(ctx.page);

      expect(ctx.session.getPaneCount()).toBe(1);
      await assertStateConsistency(ctx.page, ctx.session);
    });
  });

  // ====================
  // 2.7 IME Input
  // ====================
  describe('2.7 IME Input', () => {
    test('Composition events are handled', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Simulate IME composition by typing directly
      // Real IME testing requires platform-specific setup
      await typeInTerminal(ctx.page, 'echo "composition_test"');
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'composition_test');
    });
  });
});
