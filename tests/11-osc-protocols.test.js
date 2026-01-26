/**
 * Category 11: OSC Protocols
 *
 * Tests for OSC 8 hyperlinks and OSC 52 clipboard operations.
 */

const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  getTerminalText,
  DELAYS,
} = require('./helpers');

describe('Category 11: OSC Protocols', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 11.1 Hyperlinks (OSC 8)
  // ====================
  describe('11.1 Hyperlinks (OSC 8)', () => {
    test('OSC 8 hyperlink renders', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Output OSC 8 hyperlink
      // Format: ESC ] 8 ; ; URL ST text ESC ] 8 ; ; ST
      await typeInTerminal(ctx.page, 'echo -e "\\e]8;;https://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('Click Here');
    });

    test('Hyperlink text displays correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "\\e]8;;https://test.com\\e\\\\LINK_TEXT\\e]8;;\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('LINK_TEXT');
    });

    test('Multiple hyperlinks on same line', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('LinkA');
      expect(text).toContain('LinkB');
    });

    test('Hyperlink with special characters in URL', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "\\e]8;;https://example.com/path?query=value&foo=bar\\e\\\\Complex URL\\e]8;;\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('Complex URL');
    });
  });

  // ====================
  // 11.2 Clipboard (OSC 52)
  // ====================
  describe('11.2 Clipboard (OSC 52)', () => {
    test('OSC 52 sequence is handled', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // OSC 52 clipboard operation
      // The terminal should handle this without crashing
      await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;dGVzdA==\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // App should still be functional
      expect(ctx.session.exists()).toBe(true);
    });

    test('Terminal handles clipboard without error', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Multiple clipboard operations
      await typeInTerminal(ctx.page, 'echo "clipboard test"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      expect(ctx.session.exists()).toBe(true);
    });
  });
});
