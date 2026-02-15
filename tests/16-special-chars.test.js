/**
 * Category 16: Special Characters, Diacritics & Clipboard Paste
 *
 * Tests that special characters (;'"\\~#${}), diacritics (çåãé),
 * and clipboard paste all work correctly through the web terminal.
 */

const {
  createTestContext,
  delay,
  waitForTerminalText,
  runCommand,
  typeInTerminal,
  pressEnter,
  pasteText,
  DELAYS,
} = require('./helpers');

describe('Category 16: Special Characters & Paste', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 16.1 Special Characters
  // ====================
  describe('16.1 Special Characters', () => {
    test('Semicolon in echo command', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await runCommand(ctx.page, 'echo "a;b"', 'a;b');
    });

    test('Hash character in echo command', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await runCommand(ctx.page, 'echo "a#b"', 'a#b');
    });

    test('Dollar sign in single-quoted echo', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await runCommand(ctx.page, "echo 'a$b'", 'a$b');
    });

    test('Curly braces in echo command', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await runCommand(ctx.page, 'echo "a{b}c"', 'a{b}c');
    });

    test('Backslash in single-quoted echo', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await runCommand(ctx.page, "echo 'a\\\\b'", 'a\\b');
    });

    test('Tilde character in echo command', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await runCommand(ctx.page, 'echo "a~b"', 'a~b');
    });

    test('Single and double quotes in echo', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      // Test double quote inside single-quoted string
      await runCommand(ctx.page, "echo 'say \"hi\"'", 'say "hi"');
    });

    test('Multiple special chars combined', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await runCommand(ctx.page, 'echo "x;y#z~w"', 'x;y#z~w');
    });
  });

  // ====================
  // 16.2 Diacritics
  // ====================
  describe('16.2 Diacritics', () => {
    test('Diacritic characters via keyboard.type()', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      // Use keyboard.type() which sends compositionend-style events
      // for pre-composed characters
      await typeInTerminal(ctx.page, 'echo "café"');
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'café');
    });
  });

  // ====================
  // 16.3 Clipboard Paste
  // ====================
  describe('16.3 Clipboard Paste', () => {
    test('Short text paste', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      const marker = `paste_${Date.now()}`;
      await pasteText(ctx.page, `echo "${marker}"`);
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, marker);
    });

    test('Paste with special characters', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      await pasteText(ctx.page, 'echo "x;y#z"');
      await pressEnter(ctx.page);

      await waitForTerminalText(ctx.page, 'x;y#z');
    });

    test('Long text paste (>500 chars, tests chunking)', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      // Create a string > 500 chars to trigger chunking
      const marker = 'LONGPASTE';
      const filler = 'a'.repeat(600);
      await pasteText(ctx.page, `echo "${marker}_${filler}"`);
      await pressEnter(ctx.page);

      // Just verify the marker arrived — the full string is too long
      // for the terminal width but the command should execute
      await waitForTerminalText(ctx.page, marker);
    });
  });
});
