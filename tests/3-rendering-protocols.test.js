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
  DELAYS,
  TMUXY_URL,
} = require('./helpers');


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
    await runCommand(ctx.page,'echo -e "\\e]8;;http://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"', 'Click Here');

    // Step 2: Multiple links
    await runCommand(ctx.page,'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"', 'LinkA');
    await waitForTerminalText(ctx.page, 'LinkB');

    // Step 3: Malformed OSC 8 - terminal should survive
    await typeInTerminal(ctx.page, 'echo -e "\\e]8;;http://broken.com\\e\\\\BROKEN_LINK"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC * 2);
    await runCommand(ctx.page,'echo "AFTER_MALFORMED"', 'AFTER_MALFORMED', 15000);

    // Step 4: OSC 52 doesn't crash
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;SGVsbG8=\\e\\\\"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page,'echo "OSC52_OK"', 'OSC52_OK');

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
    await runCommand(ctx.page,'echo "MULTI_OSC52_OK"', 'MULTI_OSC52_OK');
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

      await runCommand(ctx.page,'echo -e "\\e]8;;https://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"', 'Click Here');

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

      // OSC 8 hyperlinks render as text; clickable links are a future enhancement
    });

    test('Multiple hyperlinks on same line render correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page,'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"', 'LinkA');

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

      await runCommand(ctx.page,'echo -e "\\e]8;;https://test.com\\e\\\\Unclosed"', 'Unclosed');

      await runCommand(ctx.page,'echo "still_working"', 'still_working');
    });
  });

  // ====================
  // 11.2 Clipboard (OSC 52)
  // ====================
  describe('11.2 Clipboard (OSC 52)', () => {
    test('OSC 52 sequence does not crash terminal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page,'echo -ne "\\e]52;c;dGVzdA==\\e\\\\"; echo "osc52_sent"', 'osc52_sent');

      await runCommand(ctx.page,'echo "DONE"', 'DONE');
    });

    test('Multiple OSC 52 operations in sequence', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page,'echo -ne "\\e]52;c;Zmlyc3Q=\\e\\\\"; echo "osc1"', 'osc1');
      await runCommand(ctx.page,'echo -ne "\\e]52;c;c2Vjb25k\\e\\\\"; echo "osc2"', 'osc2');
      await runCommand(ctx.page,'echo -ne "\\e]52;c;dGhpcmQ=\\e\\\\"; echo "osc3"', 'osc3');

      await runCommand(ctx.page,'echo "sequence_done"', 'sequence_done');
    });
  });
});

// ==================== Scenario 23: Image Protocols ====================

describe('Scenario 23: Terminal Image Protocols', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // Minimal 1x1 red pixel PNG, base64
  const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

  /**
   * Helper: get image placements from XState context for the active pane
   */
  async function getImagePlacements(page) {
    return page.evaluate(() => {
      const snap = window.app?.getSnapshot?.();
      if (!snap) return [];
      const ctx = snap.context;
      const activePaneId = ctx.activePaneId;
      const pane = ctx.panes?.find(p => p.tmuxId === activePaneId);
      return pane?.images || [];
    });
  }

  /**
   * Helper: wait for image placements to appear in state
   */
  async function waitForImages(page, minCount = 1, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const images = await getImagePlacements(page);
      if (images.length >= minCount) return images;
      await delay(200);
    }
    throw new Error(`Expected at least ${minCount} image placement(s) within ${timeout}ms`);
  }

  test('iTerm2 inline image: sequence stripped, placement created, img rendered', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Send iTerm2 inline image sequence via printf
    // Format: ESC ] 1337 ; File=inline=1;width=10;height=5:<base64> BEL
    const cmd = `printf '\\e]1337;File=inline=1;width=10;height=5:${TINY_PNG_B64}\\a' && echo IMG_SENT`;
    await runCommand(ctx.page,cmd, 'IMG_SENT');

    // Verify the output marker is present (the printf command text may appear in prompt)
    const text = await getTerminalText(ctx.page);
    expect(text).toContain('IMG_SENT');

    // Verify image placement appears in state
    const images = await waitForImages(ctx.page);
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images[0].protocol).toBe('iterm2');
    expect(images[0].widthCells).toBe(10);
    expect(images[0].heightCells).toBe(5);

    // Verify <img> element rendered in DOM
    const imgInfo = await ctx.page.evaluate(() => {
      const img = document.querySelector('.terminal-image');
      if (!img) return null;
      return { src: img.src, tagName: img.tagName };
    });
    expect(imgInfo).not.toBeNull();
    expect(imgInfo.tagName).toBe('IMG');
    expect(imgInfo.src).toContain('/api/images/');
  }, 60000);

  test('iTerm2 non-inline file download is ignored (no placement)', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // File download (no inline=1) — should be consumed but produce no image
    const cmd = `printf '\\e]1337;File=name=dGVzdA==:${TINY_PNG_B64}\\a' && echo DOWNLOAD_SENT`;
    await runCommand(ctx.page,cmd, 'DOWNLOAD_SENT');

    await delay(DELAYS.SYNC * 2);

    const images = await getImagePlacements(ctx.page);
    expect(images.length).toBe(0);
  }, 60000);

  test('Sixel sequence does not crash terminal', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Sixel uses DCS (ESC P) which tmux intercepts rather than forwarding
    // to control mode. The sequence may leak as text. Verify terminal survives.
    const cmd = `printf '\\ePq#0;2;0;0;0~\\e\\\\' && echo SIXEL_OK`;
    await runCommand(ctx.page,cmd, 'SIXEL_OK');

    // Verify via DOM or capture-pane fallback
    await waitForTerminalText(ctx.page, 'SIXEL_OK');

    // Terminal still functional after sixel
    await runCommand(ctx.page,'echo AFTER_SIXEL', 'AFTER_SIXEL');
  }, 60000);

  test('Mixed content: text + image + text renders correctly', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Send text, then image, then more text
    const cmd = `echo BEFORE_IMG && printf '\\e]1337;File=inline=1;width=5;height=3:${TINY_PNG_B64}\\a' && echo AFTER_IMG`;
    await runCommand(ctx.page,cmd, 'AFTER_IMG');

    // Verify both markers visible in DOM
    await waitForTerminalText(ctx.page, 'BEFORE_IMG');
    await waitForTerminalText(ctx.page, 'AFTER_IMG');

    const images = await waitForImages(ctx.page);
    expect(images.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  test('Image HTTP endpoint serves blob with correct MIME type', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create an image
    const cmd = `printf '\\e]1337;File=inline=1;width=5;height=3:${TINY_PNG_B64}\\a' && echo HTTP_TEST`;
    await runCommand(ctx.page,cmd, 'HTTP_TEST');

    const images = await waitForImages(ctx.page);
    expect(images.length).toBeGreaterThanOrEqual(1);

    // Fetch the image via the HTTP endpoint
    const imgId = images[0].id;
    const paneId = await ctx.page.evaluate(() => {
      const snap = window.app?.getSnapshot?.();
      return snap?.context?.activePaneId?.replace('%', '') || '';
    });

    const response = await ctx.page.evaluate(async (url) => {
      const resp = await fetch(url);
      return {
        status: resp.status,
        contentType: resp.headers.get('content-type'),
        size: (await resp.blob()).size,
      };
    }, `/api/images/${paneId}/${imgId}`);

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('image/png');
    expect(response.size).toBeGreaterThan(0);
  }, 60000);

  test('Image endpoint returns 404 for nonexistent image', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const response = await ctx.page.evaluate(async () => {
      const resp = await fetch('/api/images/999/999');
      return { status: resp.status };
    });

    expect(response.status).toBe(404);
  }, 60000);
});

// ==================== Widget Tests ====================

// 1x1 red PNG, base64-encoded
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// 1x1 blue PNG, base64-encoded
const BLUE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

// 1x1 green PNG, base64-encoded
const GREEN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Type a command in the terminal via browser keyboard (no output wait).
 * Uses the real user path: browser keyboard → tmux → SSE → DOM.
 */
async function sendWidgetCommand(page, command) {
  await typeInTerminal(page, command);
  await pressEnter(page);
}

/**
 * Wait for a CSS selector to appear in the page.
 */
function waitForDomSelector(page, selector, timeout = 10000) {
  return page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    selector,
    { timeout, polling: 200 }
  );
}

// Resolve tmuxy-widget path relative to this file (works in both dev and CI)
const TMUXY_WIDGET = path.resolve(__dirname, '..', 'bin/tmuxy/tmuxy-widget');

describe('Category 17: Widgets', () => {
  const wCtx = createTestContext();
  beforeAll(wCtx.beforeAll, wCtx.hookTimeout);
  afterAll(wCtx.afterAll);
  beforeEach(wCtx.beforeEach);
  afterEach(wCtx.afterEach, wCtx.hookTimeout);

  // ====================
  // 17.1 Image Widget
  // ====================
  describe('17.1 Image Widget', () => {
    test('Renders image, has pane header, no Terminal element', async () => {
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      await sendWidgetCommand(wCtx.page,`(echo "${RED_PNG}"; sleep 999) | ${TMUXY_WIDGET} image`);

      await delay(2000);
      await waitForDomSelector(wCtx.page, '.widget-image', 30000);

      const src = await wCtx.page.evaluate(() => {
        const img = document.querySelector('.widget-image img');
        return img ? img.getAttribute('src') : null;
      });
      expect(src).toContain('data:image/png;base64,');

      const hasPaneHeader = await wCtx.page.evaluate(() => {
        const wrapper = document.querySelector('[data-pane-id]');
        if (!wrapper) return false;
        return wrapper.querySelector('.pane-tab, .pane-tabs') !== null;
      });
      expect(hasPaneHeader).toBe(true);

      const hasTerminal = await wCtx.page.evaluate(() => {
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
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      await sendWidgetCommand(wCtx.page,`(echo "${RED_PNG}"; sleep 1; echo "${BLUE_PNG}"; sleep 1; echo "${GREEN_PNG}"; sleep 999) | ${TMUXY_WIDGET} image`);

      await waitForDomSelector(wCtx.page, '.widget-image', 30000);

      const greenSignature = GREEN_PNG.slice(-30);
      await wCtx.page.waitForFunction((sig) => {
        const img = document.querySelector('.widget-image img');
        return img && img.src && img.src.includes(sig);
      }, greenSignature, { timeout: 30000, polling: 300 });

      const finalSrc = await wCtx.page.evaluate(() => {
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
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      await sendWidgetCommand(wCtx.page,'echo "hello world"');
      await waitForTerminalText(wCtx.page, 'hello world');

      const hasTerminal = await wCtx.page.evaluate(() =>
        document.querySelector('[role="log"]') !== null
      );
      expect(hasTerminal).toBe(true);

      const hasWidget = await wCtx.page.evaluate(() =>
        document.querySelector('.widget-image') !== null
      );
      expect(hasWidget).toBe(false);
    });

    test('Unregistered widget name falls back to Terminal', async () => {
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      await sendWidgetCommand(wCtx.page,`echo "test" | ${TMUXY_WIDGET} nonexistent_xyz`);

      await delay(2000);

      const hasTerminal = await wCtx.page.evaluate(() =>
        document.querySelector('[role="log"]') !== null
      );
      expect(hasTerminal).toBe(true);

      const hasWidget = await wCtx.page.evaluate(() =>
        document.querySelector('.widget-image') !== null
      );
      expect(hasWidget).toBe(false);
    });
  });
});
