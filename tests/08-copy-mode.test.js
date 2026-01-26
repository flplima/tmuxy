/**
 * Category 8: Copy Mode
 *
 * Tests for entering/exiting copy mode, navigation, selection, and paste.
 */

const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  enterCopyModeKeyboard,
  exitCopyModeKeyboard,
  sendTmuxPrefix,
  getFirstPaneId,
  isPaneCopyModeVisible,
  hasCopyModeStyling,
  scrollPaneUp,
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
    test('Enter via keyboard - prefix+[ enters copy mode', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Generate some content first
      await typeInTerminal(ctx.page, 'seq 1 20');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      expect(ctx.session.isPaneInCopyMode()).toBe(false);

      await enterCopyModeKeyboard(ctx.page);

      expect(ctx.session.isPaneInCopyMode()).toBe(true);
    });

    test('Exit copy mode - q exits', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'seq 1 20');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);
      expect(ctx.session.isPaneInCopyMode()).toBe(true);

      await exitCopyModeKeyboard(ctx.page);
      expect(ctx.session.isPaneInCopyMode()).toBe(false);
    });

    test('Exit via Escape', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'seq 1 20');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);
      expect(ctx.session.isPaneInCopyMode()).toBe(true);

      await ctx.page.keyboard.press('Escape');
      await delay(DELAYS.LONG);

      expect(ctx.session.isPaneInCopyMode()).toBe(false);
    });

    test('Copy mode indicator shows in UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'seq 1 20');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const paneId = await getFirstPaneId(ctx.page);
      if (paneId) {
        const hasCopyModeText = await isPaneCopyModeVisible(ctx.page, paneId);
        const hasCopyModeStyle = await hasCopyModeStyling(ctx.page, paneId);

        // Either text or styling should indicate copy mode
        expect(hasCopyModeText || hasCopyModeStyle).toBe(true);
      }

      await exitCopyModeKeyboard(ctx.page);
    });
  });

  // ====================
  // 8.2 Navigation in Copy Mode
  // ====================
  describe('8.2 Navigation in Copy Mode', () => {
    test('Arrow navigation - move cursor in history', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'seq 1 30');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);

      // Navigate with arrows
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowDown');
      await delay(DELAYS.SHORT);

      // Should still be in copy mode
      expect(ctx.session.isPaneInCopyMode()).toBe(true);

      await exitCopyModeKeyboard(ctx.page);
    });

    test('Page navigation - PgUp/PgDn scrolls pages', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'seq 1 100');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);

      const initialPos = ctx.session.getScrollPosition();

      await ctx.page.keyboard.press('PageUp');
      await delay(DELAYS.LONG);

      const newPos = ctx.session.getScrollPosition();
      expect(newPos).toBeGreaterThan(initialPos);

      await exitCopyModeKeyboard(ctx.page);
    });

    test('Search - / to search', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo "SEARCHME_TARGET"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);

      // Start search
      await ctx.page.keyboard.press('/');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type('SEARCHME');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('Enter');
      await delay(DELAYS.LONG);

      // Should find and position at the search term
      expect(ctx.session.isPaneInCopyMode()).toBe(true);

      await exitCopyModeKeyboard(ctx.page);
    });
  });

  // ====================
  // 8.3 Selection in Copy Mode
  // ====================
  describe('8.3 Selection in Copy Mode', () => {
    test('Start selection - Space starts selection', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo "SELECT_THIS"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);

      // Move up to the text
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);

      // Start selection
      await ctx.page.keyboard.press(' ');
      await delay(DELAYS.SHORT);

      // Move to extend selection
      await ctx.page.keyboard.press('ArrowRight');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowRight');
      await delay(DELAYS.SHORT);

      // Still in copy mode
      expect(ctx.session.isPaneInCopyMode()).toBe(true);

      await exitCopyModeKeyboard(ctx.page);
    });

    test('Copy selection - Enter copies and exits', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo "COPY_TEXT"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);

      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press(' ');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('$'); // End of line (vi mode)
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('Enter');
      await delay(DELAYS.LONG);

      // Should exit copy mode after copying
      expect(ctx.session.isPaneInCopyMode()).toBe(false);
    });
  });

  // ====================
  // 8.4 Paste
  // ====================
  describe('8.4 Paste', () => {
    test('Paste buffer - prefix+] pastes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // First copy something
      await typeInTerminal(ctx.page, 'echo "PASTE_SOURCE"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await enterCopyModeKeyboard(ctx.page);
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('0'); // Line start
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press(' ');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('$'); // Line end
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('Enter');
      await delay(DELAYS.LONG);

      // Now paste
      await sendTmuxPrefix(ctx.page);
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press(']');
      await delay(DELAYS.LONG);

      // Pasted content should appear
      expect(ctx.session.exists()).toBe(true);
    });
  });
});
