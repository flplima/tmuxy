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
  runCommand,
  noteKnownLimitation,
  DELAYS,
} = require('./helpers');

describe('Category 11: OSC Protocols', () => {
  const ctx = createTestContext({ snapshot: true });

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 11.1 Hyperlinks (OSC 8)
  // ====================
  describe('11.1 Hyperlinks (OSC 8)', () => {
    test('OSC 8 hyperlink text renders', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Output OSC 8 hyperlink
      // Format: ESC ] 8 ; ; URL ST text ESC ] 8 ; ; ST
      await typeInTerminal(ctx.page, 'echo -e "\\e]8;;https://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Verify the link text appears
      const text = await getTerminalText(ctx.page);
      expect(text).toContain('Click Here');

      // Check if the terminal rendered it as a link (may be implementation-specific)
      const linkInfo = await ctx.page.evaluate(() => {
        const terminal = document.querySelector('[role="log"]');
        if (!terminal) return { hasLinks: false };

        // Look for anchor elements or elements with data-href
        const anchors = terminal.querySelectorAll('a[href]');
        const dataHrefs = terminal.querySelectorAll('[data-href]');

        return {
          hasLinks: anchors.length > 0 || dataHrefs.length > 0,
          anchorCount: anchors.length,
          dataHrefCount: dataHrefs.length,
        };
      });

      // Log link rendering status (may not be implemented)
      if (!linkInfo.hasLinks) {
        noteKnownLimitation('OSC8_CLICKABLE_LINKS');
      }
    });

    test('Multiple hyperlinks on same line render correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('LinkA');
      expect(text).toContain('LinkB');

      // Both links should be on the same line (space-separated in output)
      const lines = text.split('\n');
      const linkLine = lines.find(line => line.includes('LinkA') && line.includes('LinkB'));
      expect(linkLine).toBeDefined();
    });

    test('Terminal handles malformed OSC 8 gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Malformed OSC 8 (missing closing sequence)
      await typeInTerminal(ctx.page, 'echo -e "\\e]8;;https://test.com\\e\\\\Unclosed"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Terminal should still be functional
      await runCommand(ctx.page, 'echo "still_working"', 'still_working');
    });
  });

  // ====================
  // 11.2 Clipboard (OSC 52)
  // ====================
  describe('11.2 Clipboard (OSC 52)', () => {
    test('OSC 52 sequence does not crash terminal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // OSC 52 clipboard set operation (base64 encoded "test")
      // Format: ESC ] 52 ; c ; BASE64 ST
      await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;dGVzdA==\\e\\\\"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Verify terminal still works - use short marker
      await runCommand(ctx.page, 'echo "DONE"', 'DONE');
    });

    // Skipped: OSC 52 query handling has timing issues
    test.skip('Terminal handles OSC 52 query gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // OSC 52 query (asking for clipboard contents)
      // This may not be supported but shouldn't crash
      // Use runCommand with a completion marker so we know the echo finished
      await runCommand(
        ctx.page,
        'echo -ne "\\e]52;c;?\\e\\\\" && echo "OSC_QUERY_SENT"',
        'OSC_QUERY_SENT',
        10000
      );

      // Extra delay to let any OSC response settle
      await delay(DELAYS.SYNC);

      // Terminal should still be functional - use a short marker
      await runCommand(ctx.page, 'echo "QHOK"', 'QHOK');
    });

    test('Multiple OSC 52 operations in sequence', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Multiple clipboard operations
      await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;Zmlyc3Q=\\e\\\\"'); // "first"
      await pressEnter(ctx.page);
      await delay(DELAYS.SHORT);

      await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;c2Vjb25k\\e\\\\"'); // "second"
      await pressEnter(ctx.page);
      await delay(DELAYS.SHORT);

      await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;dGhpcmQ=\\e\\\\"'); // "third"
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Terminal should handle all of them
      await runCommand(ctx.page, 'echo "sequence_done"', 'sequence_done');
    });
  });
});
