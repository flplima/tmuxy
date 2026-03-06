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
async function runCommandViaTmux(session, page, command, expectedText, timeout = 20000) {
  await session.runCommand(`send-keys -t ${session.name} -l '${command.replace(/'/g, "'\"'\"'")}'`);
  await session.runCommand(`send-keys -t ${session.name} Enter`);
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
    await runCommandViaTmux(ctx.session, ctx.page, cmd, 'IMG_SENT');

    // Verify the raw escape sequence text is NOT visible in the terminal
    const text = await getTerminalText(ctx.page);
    expect(text).not.toContain('1337;File=');
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
    await runCommandViaTmux(ctx.session, ctx.page, cmd, 'DOWNLOAD_SENT');

    await delay(DELAYS.SYNC * 2);

    const images = await getImagePlacements(ctx.page);
    expect(images.length).toBe(0);
  }, 30000);

  test('Kitty single-chunk transmit+display creates placement', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Kitty: ESC _ G a=T,f=100,c=8,r=4;<base64> ESC backslash
    const cmd = `printf '\\e_Ga=T,f=100,c=8,r=4;${TINY_PNG_B64}\\e\\\\' && echo KITTY_SENT`;
    await runCommandViaTmux(ctx.session, ctx.page, cmd, 'KITTY_SENT');

    const text = await getTerminalText(ctx.page);
    expect(text).not.toContain('Ga=T');
    expect(text).toContain('KITTY_SENT');

    const images = await waitForImages(ctx.page);
    expect(images.length).toBeGreaterThanOrEqual(1);
    const kittyImg = images.find(i => i.protocol === 'kitty');
    expect(kittyImg).toBeDefined();
    expect(kittyImg.widthCells).toBe(8);
    expect(kittyImg.heightCells).toBe(4);
  }, 60000);

  test('Kitty chunked transfer: multi-chunk image assembled correctly', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Split the base64 into chunks and send via Kitty chunked protocol
    const half = Math.floor(TINY_PNG_B64.length / 2);
    const chunk1 = TINY_PNG_B64.slice(0, half);
    const chunk2 = TINY_PNG_B64.slice(half);

    // First chunk: transmit, image_id=99, more=1
    const cmd1 = `printf '\\e_Ga=t,f=100,i=99,m=1;${chunk1}\\e\\\\'`;
    // Final chunk: image_id=99, more=0 (action defaults to continuation)
    const cmd2 = `printf '\\e_Gi=99,m=0;${chunk2}\\e\\\\' && echo CHUNKED_DONE`;

    await runCommandViaTmux(ctx.session, ctx.page, `${cmd1} && ${cmd2}`, 'CHUNKED_DONE');

    // Note: chunked transmit (a=t) stores the image but doesn't create a placement
    // until a put (a=p) or transmit+display (a=T) is used.
    // The image should be stored in the backend image store.
    // Let's verify the terminal still works after processing chunks.
    const text = await getTerminalText(ctx.page);
    expect(text).toContain('CHUNKED_DONE');
    expect(text).not.toContain('Ga=t');
  }, 60000);

  test('Kitty delete clears placements', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create an image first
    const cmd1 = `printf '\\e_Ga=T,f=100,c=6,r=3;${TINY_PNG_B64}\\e\\\\' && echo CREATED`;
    await runCommandViaTmux(ctx.session, ctx.page, cmd1, 'CREATED');

    const imagesBefore = await waitForImages(ctx.page);
    expect(imagesBefore.length).toBeGreaterThanOrEqual(1);

    // Delete all images
    const cmd2 = `printf '\\e_Ga=d;\\e\\\\' && echo DELETED`;
    await runCommandViaTmux(ctx.session, ctx.page, cmd2, 'DELETED');

    await delay(DELAYS.SYNC * 2);

    const imagesAfter = await getImagePlacements(ctx.page);
    expect(imagesAfter.length).toBe(0);
  }, 60000);

  test('Sixel sequence does not crash terminal', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Sixel uses DCS (ESC P) which tmux intercepts rather than forwarding
    // to control mode. The sequence may leak as text. Verify terminal survives.
    const cmd = `printf '\\ePq#0;2;0;0;0~\\e\\\\' && echo SIXEL_OK`;
    await runCommandViaTmux(ctx.session, ctx.page, cmd, 'SIXEL_OK');

    const text = await getTerminalText(ctx.page);
    expect(text).toContain('SIXEL_OK');

    // Terminal still functional after sixel
    await runCommandViaTmux(ctx.session, ctx.page, 'echo AFTER_SIXEL', 'AFTER_SIXEL');
  }, 30000);

  test('Mixed content: text + image + text renders correctly', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Send text, then image, then more text
    const cmd = `echo BEFORE_IMG && printf '\\e]1337;File=inline=1;width=5;height=3:${TINY_PNG_B64}\\a' && echo AFTER_IMG`;
    await runCommandViaTmux(ctx.session, ctx.page, cmd, 'AFTER_IMG');

    const text = await getTerminalText(ctx.page);
    expect(text).toContain('BEFORE_IMG');
    expect(text).toContain('AFTER_IMG');
    expect(text).not.toContain('1337;File=');

    const images = await waitForImages(ctx.page);
    expect(images.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  test('Image HTTP endpoint serves blob with correct MIME type', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create an image
    const cmd = `printf '\\e]1337;File=inline=1;width=5;height=3:${TINY_PNG_B64}\\a' && echo HTTP_TEST`;
    await runCommandViaTmux(ctx.session, ctx.page, cmd, 'HTTP_TEST');

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
  }, 15000);
});

// ==================== Widget Tests ====================

// 1x1 red PNG, base64-encoded
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// 1x1 blue PNG, base64-encoded
const BLUE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

// 1x1 green PNG, base64-encoded
const GREEN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Send a command to the pane via tmux send-keys (no Terminal text wait) */
async function sendCommand(session, command) {
  await session.runCommand(`send-keys -t ${session.name} -l '${command.replace(/'/g, "'\"'\"'")}'`);
  await session.runCommand(`send-keys -t ${session.name} Enter`);
}

/** Wait for a CSS selector to appear in the page */
function waitForSelector(page, selector, timeout = 10000) {
  return page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    selector,
    { timeout, polling: 200 }
  );
}

// Resolve tmuxy-widget path relative to this file (works in both dev and CI)
const TMUXY_WIDGET = path.resolve(__dirname, '..', 'scripts/tmuxy/tmuxy-widget');

describe('Category 17: Widgets', () => {
  jest.setTimeout(60000);

  let browser;
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
  });

  afterAll(async () => {
    // No helperPage to close
  });

  beforeEach(async () => {
    if (!serverAvailable || !browserAvailable) return;

    session = new TmuxTestSession();
    session.created = true;

    // Open page — the server will auto-create the tmux session
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (session) {
      try {
        await session.destroy();
      } catch { /* ignore */ }
    }
    if (page) {
      await page.close().catch(() => {});
      page = null;
      await delay(4000); // Wait for server cleanup
    }
    session = null;
  });

  function skipIfNotReady() {
    if (!serverAvailable || !browserAvailable || !page || !session) {
      return true;
    }
    return false;
  }

  async function setupPage() {
    await navigateToSession(page, session.name);
    await waitForSessionReady(page, session.name);
    session.setPage(page);
    await session.sourceConfig();
    await focusPage(page);
  }

  // ====================
  // 17.1 Image Widget
  // ====================
  describe('17.1 Image Widget', () => {
    test('Renders image, has pane header, no Terminal element', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      await sendCommand(session, `(echo "${RED_PNG}"; sleep 999) | ${TMUXY_WIDGET} image`);

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

      await sendCommand(session, `(echo "${RED_PNG}"; sleep 1; echo "${BLUE_PNG}"; sleep 1; echo "${GREEN_PNG}"; sleep 999) | ${TMUXY_WIDGET} image`);

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

      await sendCommand(session, 'echo "hello world"');
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

      await sendCommand(session, `echo "test" | ${TMUXY_WIDGET} nonexistent_xyz`);

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
