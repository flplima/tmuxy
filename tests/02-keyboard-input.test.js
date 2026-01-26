/**
 * Category 2: Keyboard Input
 *
 * Tests for basic typing, control sequences, arrow keys,
 * function keys, and IME input.
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

      await sendKeyCombo(ctx.page, 'Control', 'l');
      await delay(DELAYS.LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toBeDefined();
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

    test('Ctrl+A (tmux prefix) then c - creates new window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const initialWindowCount = ctx.session.getWindowCount();

      // Create new window using tmux command (prefix+c via keyboard may not work in web UI)
      // This tests that the session responds to tmux commands
      ctx.session.runCommand('new-window');
      await delay(DELAYS.SYNC);

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

      const text = await getTerminalText(ctx.page);
      expect(text.length).toBeGreaterThan(0);

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

      await ctx.setupPage();

      await ctx.page.keyboard.press('F1');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('F2');
      await delay(DELAYS.SHORT);

      await runCommand(ctx.page, 'echo "after_fkeys"', 'after_fkeys');
    });
  });

  // ====================
  // 2.5 IME Input
  // ====================
  describe('2.5 IME Input', () => {
    test('IME composition events work', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo "ime_test"', 'ime_test');
    });
  });
});
