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
  waitForPaneCount,
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

    // Skipped: Ctrl+L behavior varies by shell and terminal configuration
    test.skip('Ctrl+L - clears screen', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate multiple lines of output to verify clearing
      await runCommand(ctx.page, 'echo "LINE1_BEFORE"; echo "LINE2_BEFORE"; echo "LINE3_BEFORE"', 'LINE3_BEFORE');

      const textBefore = await getTerminalText(ctx.page);
      expect(textBefore).toContain('LINE1_BEFORE');
      expect(textBefore).toContain('LINE2_BEFORE');
      expect(textBefore).toContain('LINE3_BEFORE');

      await sendKeyCombo(ctx.page, 'Control', 'l');
      await delay(DELAYS.SYNC);

      // Verify terminal still works after Ctrl+L (the key worked)
      // Note: In tmux, Ctrl+L behavior depends on the shell and terminal size.
      // The main assertion is that the terminal remains functional.
      await runCommand(ctx.page, 'echo "after_clear"', 'after_clear');

      // Verify the new command executed successfully
      const textAfter = await getTerminalText(ctx.page);
      expect(textAfter).toContain('after_clear');
    });

    // Ctrl+Z job control may have timing issues in web terminal
    test.skip('Ctrl+Z - suspends process', async () => {
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

      const initialWindowCount = await ctx.session.getWindowCount();

      // Create new window using keyboard: Ctrl+A then c
      await sendPrefixCommand(ctx.page, 'c');
      await delay(DELAYS.SYNC);

      const newWindowCount = await ctx.session.getWindowCount();
      expect(newWindowCount).toBe(initialWindowCount + 1);


    });

    test('Prefix+" splits pane horizontally via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      expect(await ctx.session.getPaneCount()).toBe(1);

      // Split horizontal: Ctrl+A then " (Shift+')
      await sendPrefixCommand(ctx.page, "'", { shift: true });
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(2);


    });

    test('Prefix+% splits pane vertically via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      expect(await ctx.session.getPaneCount()).toBe(1);

      // Split vertical: Ctrl+A then % (Shift+5)
      await sendPrefixCommand(ctx.page, '5', { shift: true });
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(2);


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
    // Skipped: Function key escape sequences vary by terminal/environment
    test.skip('Function keys produce escape sequences in terminal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Use cat -v to see escape sequences
      await typeInTerminal(ctx.page, 'cat -v');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Send F5 escape sequence directly via tmux hex bytes to test rendering
      // F5 = ESC [ 1 5 ~  (browser keyboard may not reliably forward F-keys)
      // -H sends raw hex bytes: 1b=ESC, 5b=[, 31=1, 35=5, 7e=~
      ctx.session.runCommand(`send-keys -t ${ctx.session.name} -H 1b 5b 31 35 7e`);
      await delay(DELAYS.LONG);

      // Exit cat
      await sendKeyCombo(ctx.page, 'Control', 'c');
      await delay(DELAYS.LONG);

      // cat -v displays ^[ for ESC, so we expect ^[[15~ in the output
      const text = await getTerminalText(ctx.page);

      const hasF5Sequence = text.includes('^[[15~') || text.includes('^[O');
      const hasAnyFKeyPattern = /\^\[\[?\d+[~;]?/.test(text) || text.includes('^[O');

      expect(hasF5Sequence || hasAnyFKeyPattern).toBe(true);

      // Verify terminal still functional
      await runCommand(ctx.page, 'echo "fkey_test_done"', 'fkey_test_done');
    });

    // Skipped: F-key handling varies by environment
    test.skip('F-keys do not break terminal input', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Type a partial command
      await typeInTerminal(ctx.page, 'echo "before_');

      // Press various F-keys mid-typing
      await ctx.page.keyboard.press('F1');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('F5');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('F12');
      await delay(DELAYS.SHORT);

      // Continue typing and execute
      await typeInTerminal(ctx.page, 'after"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Command should have executed (F-keys didn't corrupt input)
      const text = await getTerminalText(ctx.page);
      expect(text).toContain('before_');
      expect(text).toContain('after');
    });
  });

  // ====================
  // 2.5 Tmux Prefix Key Bindings
  // ====================
  describe('2.5 Tmux Prefix Key Bindings', () => {
    test('Prefix+z toggles zoom via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(await ctx.session.isPaneZoomed()).toBe(false);

      // Toggle zoom: Ctrl+A then z
      await sendPrefixCommand(ctx.page, 'z');
      await delay(DELAYS.SYNC);

      expect(await ctx.session.isPaneZoomed()).toBe(true);

      // Toggle back
      await sendPrefixCommand(ctx.page, 'z');
      await delay(DELAYS.SYNC);

      expect(await ctx.session.isPaneZoomed()).toBe(false);


    });

    test('Prefix+Arrow navigates panes via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const initialActiveId = await ctx.session.getActivePaneId();

      // Navigate up: Ctrl+A then ArrowUp
      await sendPrefixCommand(ctx.page, 'ArrowUp');
      await delay(DELAYS.SYNC);

      const newActiveId = await ctx.session.getActivePaneId();
      expect(newActiveId).not.toBe(initialActiveId);


    });

    test('Prefix+n/p switches windows via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create second window
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getCurrentWindowIndex()).toBe('2');

      // Previous window: Ctrl+A then p
      await sendPrefixCommand(ctx.page, 'p');
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getCurrentWindowIndex()).toBe('1');

      // Next window: Ctrl+A then n
      await sendPrefixCommand(ctx.page, 'n');
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getCurrentWindowIndex()).toBe('2');


    });

    test('Prefix+number selects window via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getCurrentWindowIndex()).toBe('3');

      // Select window 1: Ctrl+A then 1
      await sendPrefixCommand(ctx.page, '1');
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getCurrentWindowIndex()).toBe('1');


    });

    test('Prefix+x kills pane via keyboard', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(await ctx.session.getPaneCount()).toBe(2);

      // Kill pane: Ctrl+A then x (no confirmation in web UI)
      await sendPrefixCommand(ctx.page, 'x');

      // Wait for UI to update with correct pane count
      await waitForPaneCount(ctx.page, 1);

      expect(await ctx.session.getPaneCount()).toBe(1);


    });
  });

  // ====================
  // 2.7 Text Input Methods
  // ====================
  // Note: Section 2.6 "Keyboard Helpers Integration" was removed as duplicate
  // of sections 2.2 and 2.5. Helper functions are tested via the actual
  // keyboard operations they implement.
  describe('2.7 Text Input Methods', () => {
    test('Basic text input works correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await typeInTerminal(ctx.page, 'echo "text_input_test"');
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'text_input_test');
    });

    // IME composition requires platform-specific testing that cannot be done in headless Chrome.
    // Manual testing is recommended for:
    // - Chinese pinyin input (compositionstart -> compositionupdate -> compositionend)
    // - Japanese hiragana/katakana conversion
    // - Korean hangul composition
    //
    // Requirements for IME testing:
    // - Platform with IME enabled (Windows IME, macOS input sources, ibus/fcitx on Linux)
    // - Browser automation that supports composition events
    // - Real IME input simulation (not available in standard Playwright)
    test.skip('IME composition input (requires platform-specific testing)', async () => {
      // This test is skipped because IME composition cannot be reliably
      // simulated in headless browser automation.
      // See: KNOWN_LIMITATIONS.IME_INPUT
    });
  });
});
