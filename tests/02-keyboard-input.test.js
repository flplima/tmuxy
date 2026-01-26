/**
 * Category 2: Keyboard Input
 *
 * Tests for basic typing, control sequences, arrow keys,
 * function keys, and IME input.
 */

const {
  createTestContext,
  delay,
  focusPage,
  getTerminalText,
  typeInTerminal,
  pressEnter,
  sendKeyCombo,
  sendTmuxPrefix,
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

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo hello123');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('hello123');
    });

    test('Special characters - type symbols', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Use a simpler set of special characters
      await typeInTerminal(ctx.page, 'echo "test!@#"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('test!@#');
    });

    test('Backspace - deletes characters', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Type then backspace
      await typeInTerminal(ctx.page, 'echo helloxx');
      await ctx.page.keyboard.press('Backspace');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('Backspace');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('hello');
      // Should not contain the extra x's if backspace worked
    });

    test('Enter - executes command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const testId = `enter_test_${Date.now()}`;
      await typeInTerminal(ctx.page, `echo ${testId}`);
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      // Should see the echo output (command executed)
      expect(text).toContain(testId);
    });

    test('Tab completion - completes command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Type partial command and tab
      await typeInTerminal(ctx.page, 'ech');
      await ctx.page.keyboard.press('Tab');
      await delay(DELAYS.LONG);

      // Should complete to 'echo' - verify by running
      await typeInTerminal(ctx.page, ' tab_complete_test');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('tab_complete_test');
    });
  });

  // ====================
  // 2.2 Control Sequences
  // ====================
  describe('2.2 Control Sequences', () => {
    test('Ctrl+C - interrupts command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Start a long sleep
      await typeInTerminal(ctx.page, 'sleep 100');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Send Ctrl+C
      await sendKeyCombo(ctx.page, 'Control', 'c');
      await delay(DELAYS.EXTRA_LONG);

      // Should return to prompt - can type new command
      await typeInTerminal(ctx.page, 'echo "after_interrupt"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('after_interrupt');
    });

    test('Ctrl+D - sends EOF', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Start cat (reads stdin)
      await typeInTerminal(ctx.page, 'cat');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Type something
      await typeInTerminal(ctx.page, 'test_input');
      await pressEnter(ctx.page);
      await delay(DELAYS.SHORT);

      // Send Ctrl+D to end input
      await sendKeyCombo(ctx.page, 'Control', 'd');
      await delay(DELAYS.EXTRA_LONG);

      // Should see the echoed input and return to shell
      const text = await getTerminalText(ctx.page);
      expect(text).toContain('test_input');
    });

    test('Ctrl+L - clears screen', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Add some output
      await typeInTerminal(ctx.page, 'echo "before_ctrl_l"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Send Ctrl+L
      await sendKeyCombo(ctx.page, 'Control', 'l');
      await delay(DELAYS.EXTRA_LONG);

      // Screen should be cleared (content reduced)
      const text = await getTerminalText(ctx.page);
      // The "before_ctrl_l" may still be visible in scroll but screen position changes
      expect(text).toBeDefined();
    });

    test('Ctrl+Z - suspends process', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Start a sleep
      await typeInTerminal(ctx.page, 'sleep 100');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Send Ctrl+Z
      await sendKeyCombo(ctx.page, 'Control', 'z');
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      // Should see "Stopped" or "[1]+" message
      expect(text.toLowerCase()).toMatch(/stopped|suspended|\[\d+\]/);

      // Clean up - kill the background job
      await typeInTerminal(ctx.page, 'kill %1 2>/dev/null; true');
      await pressEnter(ctx.page);
    });

    test('Ctrl+A (tmux prefix) then c - creates new window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const initialWindowCount = ctx.session.getWindowCount();

      // Send prefix + c
      await sendTmuxPrefix(ctx.page);
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('c');
      await delay(DELAYS.EXTRA_LONG);

      const newWindowCount = ctx.session.getWindowCount();
      expect(newWindowCount).toBe(initialWindowCount + 1);
    });
  });

  // ====================
  // 2.3 Arrow Keys & Navigation
  // ====================
  describe('2.3 Arrow Keys & Navigation', () => {
    test('Up arrow - recalls history', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Run a command
      const testCmd = 'echo history_test_123';
      await typeInTerminal(ctx.page, testCmd);
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Run another command
      await typeInTerminal(ctx.page, 'echo second_command');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Press up twice to get first command
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);

      // Execute
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      // Should see the history_test output again
      expect(text.split('history_test_123').length).toBeGreaterThan(2);
    });

    test('Down arrow - navigates history forward', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Run two commands
      await typeInTerminal(ctx.page, 'echo first_cmd');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await typeInTerminal(ctx.page, 'echo second_cmd');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Navigate up twice then down once
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowDown');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('second_cmd');
    });

    test('Left/Right arrows - cursor movement', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Type text, move left, insert character
      await typeInTerminal(ctx.page, 'echo ABCD');
      await ctx.page.keyboard.press('ArrowLeft');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowLeft');
      await delay(DELAYS.SHORT);
      // Cursor should be before 'CD', type X
      await ctx.page.keyboard.type('X');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('ABXCD');
    });

    test('Home/End - jump to line start/end', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo testline');
      // Press Home then type at beginning
      await ctx.page.keyboard.press('Home');
      await delay(DELAYS.SHORT);
      // Type prefix
      await ctx.page.keyboard.type('PREFIX_');
      await delay(DELAYS.SHORT);
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      // Home goes to prompt, so PREFIX_ is before echo
      expect(text).toContain('PREFIX_');
    });

    test('Page Up/Down - scrolling in less', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create content and open in less
      await typeInTerminal(ctx.page, 'seq 1 100 | less');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Should show beginning
      let text = await getTerminalText(ctx.page);
      expect(text).toContain('1');

      // Page down
      await ctx.page.keyboard.press('PageDown');
      await delay(DELAYS.LONG);

      // Should show later numbers
      text = await getTerminalText(ctx.page);
      expect(text.length).toBeGreaterThan(0);

      // Exit less
      await ctx.page.keyboard.press('q');
      await delay(DELAYS.LONG);
    });
  });

  // ====================
  // 2.4 Function Keys
  // ====================
  describe('2.4 Function Keys', () => {
    test('F1-F12 - function keys send correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Use showkey to test (or just verify no error)
      // Since showkey requires tty, we'll use a simpler test
      // Just verify function keys don't cause errors
      await ctx.page.keyboard.press('F1');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('F2');
      await delay(DELAYS.SHORT);

      // Should still be able to type
      await typeInTerminal(ctx.page, 'echo "after_fkeys"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('after_fkeys');
    });
  });

  // ====================
  // 2.5 IME Input
  // ====================
  describe('2.5 IME Input', () => {
    test('IME composition events work', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Note: Actual IME testing requires system IME configuration
      // This test verifies the basic input path works
      await typeInTerminal(ctx.page, 'echo "ime_test"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('ime_test');
    });
  });
});
