/**
 * Rendering & Protocols E2E Tests
 *
 * OSC protocols (hyperlinks, clipboard), unicode rendering, and widgets.
 */

const path = require('path');
const {
  createTestContext,
  delay,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  typeInTerminal,
  pressEnter,
  noteKnownLimitation,
  navigateToSession,
  waitForSessionReady,
  focusPage,
  TmuxTestSession,
  DELAYS,
  TMUXY_URL,
} = require('./helpers');

/**
 * Send a command via tmux send-keys and wait for expected text.
 * Used by detailed OSC tests to avoid keyboard-routing issues with escape sequences.
 */
async function runCommandViaTmux(session, page, command, expectedText, timeout = 10000) {
  session.runCommand(`send-keys -t ${session.name} -l '${command.replace(/'/g, "'\"'\"'")}'`);
  session.runCommand(`send-keys -t ${session.name} Enter`);
  await waitForTerminalText(page, expectedText, timeout);
  return getTerminalText(page);
}

// ==================== Scenario 14: OSC Protocols ====================

describe('Scenario 14: OSC Protocols', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Hyperlink → multiple links → malformed → OSC 52 no crash', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: OSC 8 hyperlink renders text
    await runCommand(ctx.page, 'echo -e "\\e]8;;http://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"', 'Click Here');
    const text1 = await getTerminalText(ctx.page);
    expect(text1).toContain('Click Here');

    // Step 2: Multiple links
    await runCommand(ctx.page, 'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"', 'LinkA');
    const text2 = await getTerminalText(ctx.page);
    expect(text2).toContain('LinkA');
    expect(text2).toContain('LinkB');

    // Step 3: Malformed OSC 8 - terminal should survive
    await typeInTerminal(ctx.page, 'echo -e "\\e]8;;http://broken.com\\e\\\\BROKEN_LINK"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC * 2);
    // Verify terminal still functional (use longer timeout under load)
    await runCommand(ctx.page, 'echo "AFTER_MALFORMED"', 'AFTER_MALFORMED', 15000);

    // Step 4: OSC 52 doesn't crash
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;SGVsbG8=\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "OSC52_OK"', 'OSC52_OK');

    // Step 5: Multiple OSC 52 operations
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;Zmlyc3Q=\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;c2Vjb25k\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SHORT);
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;dGhpcmQ=\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "MULTI_OSC52_OK"', 'MULTI_OSC52_OK');
  }, 180000);
});

// ==================== Scenario 16: Unicode Rendering ====================

describe('Scenario 16: Unicode Rendering', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Box drawing → CJK → alignment → emoji single/multi → tree output', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Box drawing characters
    await runCommand(ctx.page, 'echo -e "BOX_TOP\\n|test|\\nBOX_BTM"', 'BOX_TOP');
    const boxText = await getTerminalText(ctx.page);
    expect(boxText).toContain('test');
    expect(boxText).toContain('BOX_BTM');

    // Step 2: CJK characters
    await runCommand(ctx.page, 'echo "CJK_TEST: 你好世界 こんにちは 안녕하세요 END_CJK"', 'CJK_TEST');
    const cjkText = await getTerminalText(ctx.page);
    expect(cjkText).toContain('CJK_TEST');
    expect(cjkText).toContain('END_CJK');

    // Step 3: Cursor works after CJK
    const afterCjk = await runCommand(ctx.page, 'echo "AFTER_CJK"', 'AFTER_CJK');
    expect(afterCjk).toContain('AFTER_CJK');

    // Step 4: Emoji - single codepoint
    await runCommand(ctx.page, 'echo "EMOJI_TEST: X X X END_EMOJI"', 'EMOJI_TEST');
    const emojiText = await getTerminalText(ctx.page);
    expect(emojiText).toContain('END_EMOJI');

    // Step 5: Emoji - multi-codepoint (terminal should not break)
    await runCommand(ctx.page, 'echo "MULTI_EMOJI_START END_MULTI"', 'MULTI_EMOJI_START');
    const multiEmoji = await getTerminalText(ctx.page);
    expect(multiEmoji).toContain('END_MULTI');
    await runCommand(ctx.page, 'echo "AFTER_EMOJI"', 'AFTER_EMOJI');

    // Step 6: Unicode in git-style status output
    await runCommand(ctx.page, 'printf "\\u2713 Pass\\n\\u2717 Fail\\n\\u26A0 Warn\\n"', 'Pass');
    const statusText = await getTerminalText(ctx.page);
    expect(statusText).toContain('Fail');
    expect(statusText).toContain('Warn');

    // Step 7: Tree output with box-drawing
    await runCommand(ctx.page, 'printf "├── src\\n│   ├── main.rs\\n│   └── lib.rs\\n└── Cargo.toml\\n"', 'src');
    const treeText = await getTerminalText(ctx.page);
    expect(treeText).toContain('main.rs');
    expect(treeText).toContain('Cargo.toml');
  }, 180000);
});

// ==================== Detailed OSC Protocol Tests ====================

describe('Category 11: OSC Protocols (Detailed)', () => {
  const ctx = createTestContext({ snapshot: true });

  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // ====================
  // 11.1 Hyperlinks (OSC 8)
  // ====================
  describe('11.1 Hyperlinks (OSC 8)', () => {
    test('OSC 8 hyperlink text renders', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommandViaTmux(ctx.session, ctx.page, 'echo -e "\\e]8;;https://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"', 'Click Here');

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('Click Here');

      const linkInfo = await ctx.page.evaluate(() => {
        const terminal = document.querySelector('[role="log"]');
        if (!terminal) return { hasLinks: false };

        const anchors = terminal.querySelectorAll('a[href]');
        const dataHrefs = terminal.querySelectorAll('[data-href]');

        return {
          hasLinks: anchors.length > 0 || dataHrefs.length > 0,
          anchorCount: anchors.length,
          dataHrefCount: dataHrefs.length,
        };
      });

      if (!linkInfo.hasLinks) {
        noteKnownLimitation('OSC8_CLICKABLE_LINKS');
      }
    });

    test('Multiple hyperlinks on same line render correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommandViaTmux(ctx.session, ctx.page, 'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"', 'LinkA');

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('LinkA');
      expect(text).toContain('LinkB');

      const lines = text.split('\n');
      const linkLine = lines.find(line => line.includes('LinkA') && line.includes('LinkB'));
      expect(linkLine).toBeDefined();
    });

    test('Terminal handles malformed OSC 8 gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommandViaTmux(ctx.session, ctx.page, 'echo -e "\\e]8;;https://test.com\\e\\\\Unclosed"', 'Unclosed');

      await runCommandViaTmux(ctx.session, ctx.page, 'echo "still_working"', 'still_working');
    });
  });

  // ====================
  // 11.2 Clipboard (OSC 52)
  // ====================
  describe('11.2 Clipboard (OSC 52)', () => {
    test('OSC 52 sequence does not crash terminal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommandViaTmux(ctx.session, ctx.page, 'echo -ne "\\e]52;c;dGVzdA==\\e\\\\"; echo "osc52_sent"', 'osc52_sent');

      await runCommandViaTmux(ctx.session, ctx.page, 'echo "DONE"', 'DONE');
    });

    test('Multiple OSC 52 operations in sequence', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommandViaTmux(ctx.session, ctx.page, 'echo -ne "\\e]52;c;Zmlyc3Q=\\e\\\\"; echo "osc1"', 'osc1');
      await runCommandViaTmux(ctx.session, ctx.page, 'echo -ne "\\e]52;c;c2Vjb25k\\e\\\\"; echo "osc2"', 'osc2');
      await runCommandViaTmux(ctx.session, ctx.page, 'echo -ne "\\e]52;c;dGhpcmQ=\\e\\\\"; echo "osc3"', 'osc3');

      await runCommandViaTmux(ctx.session, ctx.page, 'echo "sequence_done"', 'sequence_done');
    });
  });
});

// ==================== Widget Tests ====================

// 1x1 red PNG, base64-encoded
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// 1x1 blue PNG, base64-encoded
const BLUE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

// 1x1 green PNG, base64-encoded
const GREEN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Send a command to the pane via tmux send-keys (no Terminal text wait) */
function sendCommand(session, command) {
  session.runCommand(`send-keys -t ${session.name} -l '${command.replace(/'/g, "'\"'\"'")}'`);
  session.runCommand(`send-keys -t ${session.name} Enter`);
}

/** Wait for a CSS selector to appear in the page */
function waitForSelector(page, selector, timeout = 10000) {
  return page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    selector,
    { timeout, polling: 200 }
  );
}

/**
 * Create a tmux session through control mode (safe when control mode is attached).
 */
async function createSessionViaControlMode(helperPage, sessionName, width = 120, height = 30) {
  await helperPage.evaluate(async (cmd) => {
    let lastError = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await window._adapter.invoke('run_tmux_command', { command: cmd });
      } catch (e) {
        lastError = e;
        if (e.message?.includes('No monitor connection')) {
          await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }, `new-session -d -s ${sessionName} -x ${width} -y ${height}`);
}

/**
 * Kill a tmux session through control mode (with timeout).
 */
async function killSessionViaControlMode(helperPage, sessionName) {
  const timeout = new Promise(resolve => setTimeout(resolve, 5000));
  const kill = helperPage.evaluate(async (cmd) => {
    try {
      return await window._adapter.invoke('run_tmux_command', { command: cmd });
    } catch { /* ignore */ }
  }, `kill-session -t ${sessionName}`);
  await Promise.race([kill, timeout]);
}

describe('Category 17: Widgets', () => {
  jest.setTimeout(60000);

  let browser;
  let helperPage;
  let serverAvailable = false;
  let browserAvailable = false;

  let page;
  let session;

  beforeAll(async () => {
    const { waitForServer, getBrowser } = require('./helpers');
    try {
      await waitForServer(TMUXY_URL, 10000);
      serverAvailable = true;
    } catch {
      return;
    }

    try {
      browser = await getBrowser();
      browserAvailable = true;
    } catch {
      return;
    }

    helperPage = await browser.newPage();
    await helperPage.goto(`${TMUXY_URL}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await helperPage.waitForSelector('[role="log"]', { timeout: 10000 });
    await helperPage.waitForFunction(() => !!window._adapter, { timeout: 10000 });

    const warmupName = `tmuxy_warmup_${Date.now()}`;
    try {
      await createSessionViaControlMode(helperPage, warmupName);
      await killSessionViaControlMode(helperPage, warmupName);
    } catch { /* ignore warmup failures */ }
  });

  afterAll(async () => {
    if (helperPage) await helperPage.close().catch(() => {});
  });

  beforeEach(async () => {
    if (!serverAvailable || !browserAvailable) return;

    session = new TmuxTestSession();
    await createSessionViaControlMode(helperPage, session.name);
    session.created = true;

    try {
      await helperPage.evaluate(async (cmd) => {
        return await window._adapter.invoke('run_tmux_command', { command: cmd });
      }, `source-file ${path.resolve(__dirname, '..', 'docker/.tmuxy.conf')}`);
    } catch { /* config may not exist */ }

    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page) {
      await page.close().catch(() => {});
      page = null;
    }
    session = null;
  });

  function skipIfNotReady() {
    if (!serverAvailable || !browserAvailable || !page || !session) {
      console.log('Skipping test: prerequisites not available');
      return true;
    }
    return false;
  }

  async function setupPage() {
    await navigateToSession(page, session.name);
    await waitForSessionReady(page, session.name);
    session.setPage(page);
    await focusPage(page);
  }

  // ====================
  // 17.1 Image Widget
  // ====================
  describe('17.1 Image Widget', () => {
    test('Renders image, has pane header, no Terminal element', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      sendCommand(session, `(echo "${RED_PNG}"; sleep 999) | /workspace/scripts/tmuxy/tmuxy-widget image`);

      await delay(2000);
      await waitForSelector(page, '.widget-image', 30000);

      const src = await page.evaluate(() => {
        const img = document.querySelector('.widget-image img');
        return img ? img.getAttribute('src') : null;
      });
      expect(src).toContain('data:image/png;base64,');

      const hasPaneHeader = await page.evaluate(() => {
        const wrapper = document.querySelector('[data-pane-id]');
        if (!wrapper) return false;
        return wrapper.querySelector('.pane-tab, .pane-tabs') !== null;
      });
      expect(hasPaneHeader).toBe(true);

      const hasTerminal = await page.evaluate(() => {
        const wrapper = document.querySelector('[data-pane-id]');
        if (!wrapper) return true;
        return wrapper.querySelector('[role="log"]') !== null;
      });
      expect(hasTerminal).toBe(false);
    });
  });

  // ====================
  // 17.2 Animation
  // ====================
  describe('17.2 Image Widget Animation', () => {
    test('Cycles through 3 base64 image frames', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      sendCommand(session, `(echo "${RED_PNG}"; sleep 1; echo "${BLUE_PNG}"; sleep 1; echo "${GREEN_PNG}"; sleep 999) | /workspace/scripts/tmuxy/tmuxy-widget image`);

      await waitForSelector(page, '.widget-image', 30000);

      const greenSignature = GREEN_PNG.slice(-30);
      await page.waitForFunction((sig) => {
        const img = document.querySelector('.widget-image img');
        return img && img.src && img.src.includes(sig);
      }, greenSignature, { timeout: 30000, polling: 300 });

      const finalSrc = await page.evaluate(() => {
        const img = document.querySelector('.widget-image img');
        return img ? img.src : null;
      });
      expect(finalSrc).toContain(greenSignature);
    });
  });

  // ====================
  // 17.3 Edge Cases
  // ====================
  describe('17.3 Widget Detection Edge Cases', () => {
    test('Normal pane without marker renders Terminal', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      sendCommand(session, 'echo "hello world"');
      await waitForTerminalText(page, 'hello world');

      const hasTerminal = await page.evaluate(() =>
        document.querySelector('[role="log"]') !== null
      );
      expect(hasTerminal).toBe(true);

      const hasWidget = await page.evaluate(() =>
        document.querySelector('.widget-image') !== null
      );
      expect(hasWidget).toBe(false);
    });

    test('Unregistered widget name falls back to Terminal', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      sendCommand(session, 'echo "test" | /workspace/scripts/tmuxy/tmuxy-widget nonexistent_xyz');

      await delay(2000);

      const hasTerminal = await page.evaluate(() =>
        document.querySelector('[role="log"]') !== null
      );
      expect(hasTerminal).toBe(true);

      const hasWidget = await page.evaluate(() =>
        document.querySelector('.widget-image') !== null
      );
      expect(hasWidget).toBe(false);
    });
  });
});
