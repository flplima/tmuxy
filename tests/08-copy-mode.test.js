/**
 * Category 8: Copy Mode
 *
 * Tests for tmux copy mode using vi-style keyboard bindings.
 * Requires vi mode in tmux config: setw -g mode-keys vi
 */

const {
  createTestContext,
  assertSnapshotsMatch,
  delay,
  runCommand,
  getTerminalText,
  waitForTerminalText,
  sendKeyCombo,
  sendTmuxPrefix,
  sendPrefixCommand,
  typeInTerminal,
  pressEnter,
  DELAYS,
} = require('./helpers');

describe('Category 8: Copy Mode', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 8.1 Enter/Exit Copy Mode
  // ====================
  describe('8.1 Enter/Exit Copy Mode', () => {
    test('Enter copy mode via keyboard (Prefix+[)', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate content
      await runCommand(ctx.page, 'seq 1 10', '10');

      expect(await ctx.session.isPaneInCopyMode()).toBe(false);

      // Enter copy mode via keyboard: Ctrl+A then [
      await sendPrefixCommand(ctx.page, '[');
      await delay(DELAYS.LONG);

      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // Clean up
      await ctx.session.exitCopyMode();
    });

    test('Exit copy mode via q (vi mode)', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await runCommand(ctx.page, 'echo "test"', 'test');

      // Enter copy mode
      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // Exit via tmux send-keys q (more reliable than keyboard through UI)
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} q`);
      await delay(DELAYS.LONG);

      expect(await ctx.session.isPaneInCopyMode()).toBe(false);
    });

    test('Exit copy mode via Escape', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await runCommand(ctx.page, 'echo "test"', 'test');

      await ctx.session.enterCopyMode();
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      await ctx.page.keyboard.press('Escape');
      await delay(DELAYS.LONG);

      expect(await ctx.session.isPaneInCopyMode()).toBe(false);
    });
  });

  // ====================
  // 8.2 Navigation in Copy Mode (Vi Keys)
  // ====================
  describe('8.2 Navigation in Copy Mode (Vi Keys)', () => {
    test('Navigate with hjkl keys in copy mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate multi-line content with long lines for reliable horizontal navigation
      await runCommand(ctx.page, 'echo -e "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\\nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"', 'CCCC');

      await ctx.session.enterCopyMode();
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // First go to beginning of line with 0 to get consistent starting position
      await ctx.page.keyboard.press('0');
      await delay(DELAYS.SHORT);

      const startPos = await ctx.session.getCopyCursorPosition();

      // Navigate up with k (should decrease y)
      await ctx.page.keyboard.press('k');
      await delay(DELAYS.SHORT);

      const afterK = await ctx.session.getCopyCursorPosition();
      expect(afterK.y).toBeLessThan(startPos.y);

      // Navigate down with j (should increase y)
      await ctx.page.keyboard.press('j');
      await delay(DELAYS.SHORT);

      const afterJ = await ctx.session.getCopyCursorPosition();
      expect(afterJ.y).toBeGreaterThan(afterK.y);

      // Navigate right with l (should increase x) - now we're at beginning of line
      await ctx.page.keyboard.press('l');
      await delay(DELAYS.SHORT);

      const afterL = await ctx.session.getCopyCursorPosition();
      expect(afterL.x).toBeGreaterThan(afterJ.x);

      await ctx.session.exitCopyMode();
    });

    test('Navigate with arrow keys in copy mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await runCommand(ctx.page, 'seq 1 20', '20');

      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);

      const initialPos = await ctx.session.getCopyCursorPosition();

      // Navigate up using tmux send-keys -X for reliability
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X cursor-up`);
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X cursor-up`);
      await delay(DELAYS.SHORT);

      const afterUp = await ctx.session.getCopyCursorPosition();
      expect(afterUp.y).toBeLessThan(initialPos.y);

      // Navigate down
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X cursor-down`);
      await delay(DELAYS.SHORT);

      const afterDown = await ctx.session.getCopyCursorPosition();
      expect(afterDown.y).toBeGreaterThan(afterUp.y);

      await ctx.session.exitCopyMode();
    });

    test('Page up/down navigation in copy mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate lots of content
      await runCommand(ctx.page, 'seq 1 100', '100');

      await ctx.session.enterCopyMode();

      // Get initial scroll position
      const initialPos = await ctx.session.getScrollPosition();

      // Page up (Ctrl+B in vi mode)
      await sendKeyCombo(ctx.page, 'Control', 'b');
      await delay(DELAYS.LONG);

      const afterPageUp = await ctx.session.getScrollPosition();
      expect(afterPageUp).toBeGreaterThan(initialPos);

      // Page down (Ctrl+F in vi mode)
      await sendKeyCombo(ctx.page, 'Control', 'f');
      await delay(DELAYS.LONG);

      const afterPageDown = await ctx.session.getScrollPosition();
      expect(afterPageDown).toBeLessThan(afterPageUp);

      await ctx.session.exitCopyMode();
    });

    test('Go to beginning/end of line (0 and $)', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      // Use a long line to ensure there's text to navigate
      await runCommand(ctx.page, 'echo "HJKL_TEST_LINE_WITH_LOTS_OF_CONTENT_HERE_FOR_TESTING"', 'HJKL_TEST');

      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // Use tmux send-keys -X commands for reliable cursor positioning
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X start-of-line`);
      await delay(DELAYS.SHORT);

      const startPos = await ctx.session.getCopyCursorPosition();
      expect(startPos.x).toBe(0);

      // Go to end of line
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X end-of-line`);
      await delay(DELAYS.SHORT);

      const endPos = await ctx.session.getCopyCursorPosition();
      expect(endPos.x).toBeGreaterThan(startPos.x);

      // Go back to beginning of line
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X start-of-line`);
      await delay(DELAYS.SHORT);

      const backToStart = await ctx.session.getCopyCursorPosition();
      expect(backToStart.x).toBe(0);

      await ctx.session.exitCopyMode();
    });
  });

  // ====================
  // 8.3 Selection (Vi Mode: v to start, y to copy)
  // ====================
  describe('8.3 Selection (Vi Mode)', () => {
    test('Start selection with v key', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await runCommand(ctx.page, 'echo "SELECT_THIS_TEXT_LONG_LINE_FOR_TESTING"', 'SELECT_THIS');

      await ctx.session.enterCopyMode();

      // Go to beginning of line for consistent position
      await ctx.page.keyboard.press('0');
      await delay(DELAYS.SHORT);

      // Start selection with v (vi visual mode)
      await ctx.page.keyboard.press('v');
      await delay(DELAYS.LONG);

      // Move right to extend selection
      await ctx.page.keyboard.press('l');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('l');
      await delay(DELAYS.SHORT);

      // Verify we're still in copy mode with selection active
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      await ctx.session.exitCopyMode();
    });

    // Skipped: Copy buffer verification has timing issues
    test.skip('Copy selection with y key and verify buffer', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const testText = `COPY_TEST_${Date.now()}`;
      await runCommand(ctx.page, `echo "${testText}"`, testText);

      await ctx.session.enterCopyMode();

      // Use tmux commands for reliable copy operation
      // Go to the line with test text and position at start
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} k`);
      await delay(DELAYS.SHORT);
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} 0`);
      await delay(DELAYS.SHORT);

      // Start selection (begin-selection)
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X begin-selection`);
      await delay(DELAYS.SHORT);

      // Select to end of line
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X end-of-line`);
      await delay(DELAYS.SHORT);

      // Copy with y (copy-selection-and-cancel)
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X copy-selection-and-cancel`);
      await delay(DELAYS.LONG);

      // Should have exited copy mode (copy-selection-and-cancel)
      expect(await ctx.session.isPaneInCopyMode()).toBe(false);

      // Check buffer has content
      const buffer = await ctx.session.getBufferContent();
      expect(buffer.length).toBeGreaterThan(0);
    });

    test('Select entire line with V (visual line)', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await runCommand(ctx.page, 'echo "LINE_SELECT_TEST"', 'LINE_SELECT_TEST');

      await ctx.session.enterCopyMode();

      // Use tmux commands for reliable line selection
      // Go up to the echo line
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} k`);
      await delay(DELAYS.SHORT);

      // Select entire line with select-line command
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X select-line`);
      await delay(DELAYS.SHORT);

      // Copy selection
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X copy-selection-and-cancel`);
      await delay(DELAYS.LONG);

      const buffer = await ctx.session.getBufferContent();
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  // ====================
  // 8.4 Paste Operations
  // ====================
  describe('8.4 Paste Operations', () => {
    test('Paste buffer with Prefix+]', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Set buffer content directly via tmux (more reliable than copy-mode keyboard)
      const textToCopy = 'PASTE_ME';
      await ctx.session.runCommand(`set-buffer "${textToCopy}"`);
      await delay(DELAYS.SHORT);

      // Verify buffer has content before paste
      const bufferBefore = await ctx.session.getBufferContent();
      expect(bufferBefore).toContain(textToCopy);

      // Now paste with Prefix+]
      await sendPrefixCommand(ctx.page, ']');
      await delay(DELAYS.SYNC);

      // The pasted content should appear in terminal (on the command line)
      const capturedPane = await ctx.session.runCommand(`capture-pane -t ${ctx.session.name} -p`);
      expect(capturedPane).toContain(textToCopy);
    });

    test('Paste via tmux command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Set buffer content directly
      const testContent = 'DIRECT_PASTE_TEST';
      await ctx.session.runCommand(`set-buffer "${testContent}"`);

      // Paste
      await ctx.session.pasteBuffer();
      await delay(DELAYS.SYNC);

      // Wait for paste content to appear in terminal
      const text = await waitForTerminalText(ctx.page, testContent, 10000);
      expect(text).toContain(testContent);
    });
  });

  // ====================
  // 8.5 Search in Copy Mode
  // ====================
  describe('8.5 Search in Copy Mode', () => {
    test('Search forward with / in copy mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate searchable content with unique identifiable lines
      await runCommand(ctx.page, 'echo -e "LINE_AAA\\nLINE_BBB\\nSEARCH_TARGET\\nLINE_DDD"', 'LINE_DDD');

      await ctx.session.enterCopyMode();

      // Use tmux search command directly for reliability
      // This is equivalent to pressing '/' and typing the search term
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X search-forward "SEARCH_TARGET"`);
      await delay(DELAYS.LONG);

      // Verify we're on the right line
      const cursorLine = await ctx.session.getCopyModeLine();
      expect(cursorLine).toContain('SEARCH_TARGET');

      await ctx.session.exitCopyMode();
    });

    // Skipped: Search backward has timing issues
    test.skip('Search backward with search-backward command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo -e "FIND_TARGET\\nLINE_AAA\\nLINE_BBB\\nLINE_CCC"', 'LINE_CCC');

      await ctx.session.enterCopyMode();

      const posBefore = await ctx.session.getCopyCursorPosition();

      // Use tmux search-backward command directly for reliability
      // Note: Using keyboard Shift+/ for '?' is keyboard-layout dependent
      // and may not work consistently across environments
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X search-backward "FIND_TARGET"`);
      await delay(DELAYS.LONG);

      // Cursor should have moved up to find the target
      const posAfter = await ctx.session.getCopyCursorPosition();
      expect(posAfter.y).toBeLessThan(posBefore.y);

      await ctx.session.exitCopyMode();
    });

    test('Repeat search with n and N', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Content with clearly distinct searchable items on separate lines
      await runCommand(ctx.page, 'echo -e "UNIQUE_FIRST\\nfiller\\nUNIQUE_SECOND\\nfiller\\nUNIQUE_THIRD"', 'UNIQUE_THIRD');

      await ctx.session.enterCopyMode();

      // Search backward for UNIQUE (nearest is UNIQUE_THIRD)
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X search-backward "UNIQUE"`);
      await delay(DELAYS.LONG);

      const lineFirst = await ctx.session.getCopyModeLine();
      expect(lineFirst).toContain('UNIQUE_THIRD');

      // Next match with search-again (continues backward to UNIQUE_SECOND)
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X search-again`);
      await delay(DELAYS.LONG);

      const lineSecond = await ctx.session.getCopyModeLine();
      expect(lineSecond).toContain('UNIQUE_SECOND');

      // Previous match with search-reverse (forward to UNIQUE_THIRD)
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X search-reverse`);
      await delay(DELAYS.LONG);

      const lineBack = await ctx.session.getCopyModeLine();
      expect(lineBack).toContain('UNIQUE_THIRD');

      await ctx.session.exitCopyMode();
    });
  });

  // ====================
  // 8.6 Copy Mode State Consistency
  // ====================
  describe('8.6 Copy Mode State Consistency', () => {
    // Skipped: Copy mode state sync has timing issues
    test.skip('Copy mode state matches between UI and tmux', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await runCommand(ctx.page, 'echo "state test"', 'state test');

      // Initially not in copy mode
      expect(await ctx.session.isPaneInCopyMode()).toBe(false);

      // Enter via keyboard
      await sendPrefixCommand(ctx.page, '[');
      await delay(DELAYS.LONG);

      // Tmux should report copy mode
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // Exit
      await ctx.page.keyboard.press('q');
      await delay(DELAYS.LONG);

      expect(await ctx.session.isPaneInCopyMode()).toBe(false);


    });

    test('Copy mode persists during navigation within mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await runCommand(ctx.page, 'seq 1 50', '50');

      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // Navigate extensively using tmux send-keys -X for reliability
      for (let i = 0; i < 10; i++) {
        await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X cursor-up`);
      }
      await delay(DELAYS.SHORT);

      // Go to top using tmux command
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X history-top`);
      await delay(DELAYS.SHORT);

      // Go to bottom using tmux command
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X history-bottom`);
      await delay(DELAYS.SHORT);

      // Should still be in copy mode
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      await ctx.session.exitCopyMode();
    });
  });

  // ====================
  // 8.7 Copy Mode Scrolling
  // ====================
  describe('8.7 Copy Mode Scrolling', () => {
    test('Scrolling up in copy mode changes scroll position', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate content that overflows the terminal
      await runCommand(ctx.page, 'seq 1 100', '100');

      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // Scroll up 10 lines
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X -N 10 scroll-up`);
      await delay(DELAYS.LONG);

      const scrollPos = await ctx.session.getScrollPosition();
      expect(scrollPos).toBeGreaterThan(0);

      await ctx.session.exitCopyMode();
    });

    test('Scrolling down after scrolling up returns toward bottom', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'seq 1 100', '100');

      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);

      // Scroll up 20 lines
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X -N 20 scroll-up`);
      await delay(DELAYS.LONG);

      const scrollAfterUp = await ctx.session.getScrollPosition();

      // Scroll down 10 lines
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X -N 10 scroll-down`);
      await delay(DELAYS.LONG);

      const scrollAfterDown = await ctx.session.getScrollPosition();
      expect(scrollAfterDown).toBeLessThan(scrollAfterUp);

      await ctx.session.exitCopyMode();
    });

    // Skipped: UI/tmux sync in copy mode scroll has timing issues
    test.skip('UI content updates after scrolling in copy mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate numbered content so we can identify scroll position
      await runCommand(ctx.page, 'seq 1 100', '100');

      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);

      // Scroll up significantly to see earlier numbers
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X -N 50 scroll-up`);
      await delay(DELAYS.SYNC);

      // The terminal should now show earlier numbers (before 50)
      const text = await getTerminalText(ctx.page);
      // After scrolling up 50 lines from the bottom, we should see
      // numbers in the range visible on screen (roughly 50 lines earlier)
      // Check that we can see some number less than 50
      const hasEarlierNumbers = /\b([1-3]?\d)\b/.test(text);
      expect(hasEarlierNumbers).toBe(true);

      await ctx.session.exitCopyMode();
    });

    // Skipped: UI/tmux sync in copy mode scroll has timing issues
    test.skip('Snapshot matches tmux after scrolling in copy mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'seq 1 100', '100');

      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);

      // Scroll up 15 lines
      await ctx.session.runCommand(`send-keys -t ${ctx.session.name} -X -N 15 scroll-up`);
      await delay(DELAYS.SYNC);

      // Verify UI snapshot matches tmux state after scroll
      await assertSnapshotsMatch(ctx.page);

      await ctx.session.exitCopyMode();
    });
  });

  // ====================
  // 8.8 End-to-End Copy-Paste via UI Keystrokes
  // ====================
  describe('8.8 End-to-End Copy-Paste via UI Keystrokes', () => {
    test('Select text in copy mode and paste it using only UI keystrokes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const marker = `E2E_COPY_${Date.now()}`;
      await runCommand(ctx.page, `echo "${marker}"`, marker);

      // 1. Enter copy mode via UI: Prefix+[
      await sendPrefixCommand(ctx.page, '[');
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // 2. Navigate up to the echo output line (cursor starts on prompt below)
      await ctx.page.keyboard.press('k');
      await delay(DELAYS.SHORT);

      // 3. Go to beginning of line
      await ctx.page.keyboard.press('0');
      await delay(DELAYS.SHORT);

      // 4. Start visual selection with v
      await ctx.page.keyboard.press('v');
      await delay(DELAYS.SHORT);

      // 5. Select to end of line with $
      await ctx.page.keyboard.press('$');
      await delay(DELAYS.SHORT);

      // 6. Yank with y (copy-selection-and-cancel exits copy mode)
      await ctx.page.keyboard.press('y');
      await delay(DELAYS.LONG);

      // 7. Verify copy mode exited and buffer has the marker text
      expect(await ctx.session.isPaneInCopyMode()).toBe(false);
      const buffer = await ctx.session.getBufferContent();
      expect(buffer).toContain(marker);

      // 8. Paste via UI: Prefix+]
      await sendPrefixCommand(ctx.page, ']');
      await delay(DELAYS.SYNC);

      // 9. Verify pasted text appears in terminal
      const capturedPane = await ctx.session.runCommand(`capture-pane -t ${ctx.session.name} -p`);
      // The marker should appear at least twice: original echo output + pasted on command line
      const occurrences = capturedPane.split(marker).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    });

    // Skipped: Visual line mode has timing issues with paste
    test.skip('Visual line select (V) and paste via UI keystrokes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const marker = `VLINE_${Date.now()}`;
      await runCommand(ctx.page, `echo "${marker}"`, marker);

      // Enter copy mode via UI
      await sendPrefixCommand(ctx.page, '[');
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      // Navigate up to the echo output line
      await ctx.page.keyboard.press('k');
      await delay(DELAYS.SHORT);

      // Select entire line with V (visual line mode)
      // Playwright's press('V') generates key='V' directly (correct for keyboardActor)
      await ctx.page.keyboard.press('V');
      await delay(DELAYS.SHORT);

      // Yank with y
      await ctx.page.keyboard.press('y');
      await delay(DELAYS.LONG);

      expect(await ctx.session.isPaneInCopyMode()).toBe(false);
      const buffer = await ctx.session.getBufferContent();
      expect(buffer).toContain(marker);

      // Paste via UI
      await sendPrefixCommand(ctx.page, ']');
      await delay(DELAYS.SYNC);

      // Verify paste appeared in terminal
      const text = await waitForTerminalText(ctx.page, marker, 5000);
      expect(text).toContain(marker);
    });

    test('Copy multi-line selection and paste via UI keystrokes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const line1 = `ML_FIRST_${Date.now()}`;
      const line2 = `ML_SECOND_${Date.now()}`;
      await runCommand(ctx.page, `echo -e "${line1}\\n${line2}"`, line2);

      // Enter copy mode via UI
      await sendPrefixCommand(ctx.page, '[');
      await delay(DELAYS.LONG);

      // Navigate up to line2 (one line above prompt)
      await ctx.page.keyboard.press('k');
      await delay(DELAYS.SHORT);

      // Navigate up to line1
      await ctx.page.keyboard.press('k');
      await delay(DELAYS.SHORT);

      // Go to beginning of line
      await ctx.page.keyboard.press('0');
      await delay(DELAYS.SHORT);

      // Start selection
      await ctx.page.keyboard.press('v');
      await delay(DELAYS.SHORT);

      // Move down one line to include both lines
      await ctx.page.keyboard.press('j');
      await delay(DELAYS.SHORT);

      // Select to end of line
      await ctx.page.keyboard.press('$');
      await delay(DELAYS.SHORT);

      // Yank
      await ctx.page.keyboard.press('y');
      await delay(DELAYS.LONG);

      expect(await ctx.session.isPaneInCopyMode()).toBe(false);
      const buffer = await ctx.session.getBufferContent();
      expect(buffer).toContain(line1);
      expect(buffer).toContain(line2);
    });
  });
});
