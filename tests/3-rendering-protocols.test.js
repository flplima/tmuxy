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
  sendKeyCombo,
  waitForShellPrompt,
  DELAYS,
  waitForCondition,
  getCellWidth,
  getCursorGeometry,
  getRunGeometry,
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
    await runCommand(
      ctx.page,
      'echo -e "\\e]8;;http://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"',
      'Click Here',
    );

    // Step 2: Multiple links
    await runCommand(
      ctx.page,
      'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"',
      'LinkA',
    );
    await waitForTerminalText(ctx.page, 'LinkB');

    // Step 3: Malformed OSC 8 - terminal should survive
    await typeInTerminal(ctx.page, 'echo -e "\\e]8;;http://broken.com\\e\\\\BROKEN_LINK"');
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC * 2);
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

  test('OSC 2 pane title shows in the header, falling back to the process name', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // Reads the rendered header title AND its box, so a title that is present
    // in the DOM but clipped to nothing can't pass as visible.
    const readHeaderTitle = () =>
      ctx.page.evaluate(() => {
        const el = document.querySelector('.pane-tab-title');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || '').trim(), width: r.width, height: r.height };
      });

    const waitForHeaderTitle = async (expected, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      let seen = null;
      while (Date.now() < deadline) {
        seen = await readHeaderTitle();
        if (seen && seen.text === expected) return seen;
        await delay(250);
      }
      throw new Error(
        `Header title never became ${JSON.stringify(expected)} (last: ${JSON.stringify(seen)})`,
      );
    };

    // No app has set a title yet, so the header falls back to the process name.
    // The point of the assertion is the negative: it must NOT be the host name
    // tmux seeds pane_title with.
    const idle = await readHeaderTitle();
    expect(idle).not.toBeNull();
    expect(['zsh', 'bash', 'fish', 'sh', 'shell']).toContain(idle.text);

    // A long-running program announces its own title over OSC 2 — this is the
    // `claude` case, whose process name is a useless version number.
    await typeInTerminal(ctx.page, 'printf "\\033]2;CLAUDE_SESSION_TITLE\\007"; sleep 30');
    await pressEnter(ctx.page);

    const titled = await waitForHeaderTitle('CLAUDE_SESSION_TITLE');
    expect(titled.width).toBeGreaterThan(0);
    expect(titled.height).toBeGreaterThan(0);

    // Ending the program does NOT clear the title on its own: tmux keeps the
    // last title a pane was given, and it is the shell's PROMPT HOOK that
    // replaces it (docs/TMUX.md). A bare CI shell has no such hook, so drive
    // one explicitly — what is worth asserting is that the header tracks
    // whichever title is current, not that a program's title expires by itself.
    await sendKeyCombo(ctx.page, 'Control', 'c');
    await waitForShellPrompt(ctx.page);
    await typeInTerminal(ctx.page, `printf "\\033]2;${idle.text}\\007"`);
    await pressEnter(ctx.page);

    const after = await waitForHeaderTitle(idle.text);
    expect(after.width).toBeGreaterThan(0);
  }, 120000);
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
    await runCommand(
      ctx.page,
      'echo "CJK_TEST: 你好世界 こんにちは 안녕하세요 END_CJK"',
      'CJK_TEST',
    );
    const cjkText = await getTerminalText(ctx.page);
    expect(cjkText).toContain('CJK_TEST');
    expect(cjkText).toContain('END_CJK');

    // Step 3: Cursor works after CJK
    const afterCjk = await runCommand(ctx.page, 'echo "AFTER_CJK"', 'AFTER_CJK');
    expect(afterCjk).toContain('AFTER_CJK');

    // Step 4: Emoji - single codepoint (the old payload said EMOJI but
    // contained only ASCII X's, so the wide-glyph path was never exercised)
    // printf expands \xNN, so the typed command stays ASCII-safe while the
    // terminal receives real UTF-8 emoji bytes.
    await runCommand(
      ctx.page,
      'printf "EMOJI_TEST: \\xf0\\x9f\\x98\\x80 \\xe2\\x9c\\x85 END_EMOJI\\n"',
      'EMOJI_TEST',
    );
    const emojiText = await getTerminalText(ctx.page);
    expect(emojiText).toContain('\u{1f600}');
    expect(emojiText).toContain('END_EMOJI');

    // Step 5: Emoji - multi-codepoint ZWJ sequence (terminal should not break)
    await runCommand(
      ctx.page,
      'printf "MULTI_EMOJI_START \\xf0\\x9f\\x91\\xa9\\xe2\\x80\\x8d\\xf0\\x9f\\x92\\xbb END_MULTI\\n"',
      'MULTI_EMOJI_START',
    );
    const multiEmoji = await getTerminalText(ctx.page);
    expect(multiEmoji).toContain('END_MULTI');
    await runCommand(ctx.page, 'echo "AFTER_EMOJI"', 'AFTER_EMOJI');

    // Step 6: Unicode in git-style status output
    await runCommand(ctx.page, 'printf "\\u2713 Pass\\n\\u2717 Fail\\n\\u26A0 Warn\\n"', 'Pass');
    const statusText = await getTerminalText(ctx.page);
    expect(statusText).toContain('Fail');
    expect(statusText).toContain('Warn');

    // Step 7: Tree output with box-drawing
    await runCommand(
      ctx.page,
      'printf "├── src\\n│   ├── main.rs\\n│   └── lib.rs\\n└── Cargo.toml\\n"',
      'src',
    );
    const treeText = await getTerminalText(ctx.page);
    expect(treeText).toContain('main.rs');
    expect(treeText).toContain('Cargo.toml');
  }, 180000);

  test('Wide glyphs stay on the tmux cell grid: CJK → emoji → ZWJ → skin tone → flag', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The browser grid is a whole number of device pixels per cell, published
    // as --cell-w (tmuxy-ui/src/utils/cellMetrics.ts).
    const cellW = await getCellWidth(ctx.page);
    expect(cellW * (await ctx.page.evaluate(() => devicePixelRatio))).toBeCloseTo(
      Math.round(cellW * (await ctx.page.evaluate(() => devicePixelRatio))),
      3,
    );

    // Each case prints a wide run followed by an ASCII marker and then parks
    // the shell in `read`, so the cursor sits right after the marker. tmux's
    // #{cursor_x} is then the oracle: the marker's rendered right edge and the
    // cursor overlay must both land on that cell, in pixels the user sees.
    // printf's \xNN escapes keep the typed command ASCII-safe.
    const cases = [
      {
        name: 'CJK',
        bytes: '\\xe4\\xbd\\xa0\\xe5\\xa5\\xbd', // 你好 — 2 wide chars = 4 cells
        wideGlyph: '\u4f60',
        marker: 'END_CJK_GRID',
      },
      {
        name: 'emoji',
        bytes: '\\xf0\\x9f\\x98\\x80\\xf0\\x9f\\x9f\\xa5', // 😀🟥 — 4 cells
        wideGlyph: '\u{1f600}',
        marker: 'END_EMO_GRID',
      },
      {
        name: 'ZWJ sequence',
        // 👩‍💻 = woman + ZWJ + laptop: one 2-cell glyph in tmux ≥ 3.3
        bytes: '\\xf0\\x9f\\x91\\xa9\\xe2\\x80\\x8d\\xf0\\x9f\\x92\\xbb',
        wideGlyph: '\u{1f469}\u200d\u{1f4bb}',
        marker: 'END_ZWJ_GRID',
      },
      {
        name: 'skin tone',
        // 👍🏽 = thumbs up + medium skin-tone modifier: one 2-cell glyph
        bytes: '\\xf0\\x9f\\x91\\x8d\\xf0\\x9f\\x8f\\xbd',
        wideGlyph: '\u{1f44d}\u{1f3fd}',
        marker: 'END_TONE_GRID',
      },
      {
        name: 'flag',
        // 🇺🇸 = two regional indicators: one 2-cell glyph
        bytes: '\\xf0\\x9f\\x87\\xba\\xf0\\x9f\\x87\\xb8',
        wideGlyph: '\u{1f1fa}\u{1f1f8}',
        marker: 'END_FLAG_GRID',
      },
    ];

    for (const c of cases) {
      await typeInTerminal(
        ctx.page,
        `printf "${c.name.slice(0, 3)} ${c.bytes} ${c.marker}"; read -r _`,
      );
      await pressEnter(ctx.page);
      await waitForTerminalText(ctx.page, c.marker);
      // Let the cursor settle on the output line (the typed command line also
      // contains the marker; the output line is the one the cursor is on).
      await delay(DELAYS.SYNC);

      const tmuxCursorX = Number(
        ctx.session.runCommand(`display-message -p -t ${ctx.session.name} '#{cursor_x}'`),
      );
      expect(tmuxCursorX).toBeGreaterThan(c.marker.length);

      // 1. The cursor overlay is painted on tmux's cell, not just addressed to it.
      const cursor = await getCursorGeometry(ctx.page);
      expect(cursor.visible).toBe(true);
      expect({ case: c.name, cursorX: cursor.x }).toEqual({ case: c.name, cursorX: tmuxCursorX });
      expect(Math.abs(cursor.col - tmuxCursorX)).toBeLessThan(0.1);
      expect(Math.abs(cursor.cols - 1)).toBeLessThan(0.1);

      // 2. The marker's rendered right edge ends exactly where tmux's cursor is:
      //    the wide glyphs before it advanced the line by their tmux width, not
      //    by their font advance.
      const marker = await getRunGeometry(ctx.page, c.marker);
      expect(marker.visible).toBe(true);
      expect(Math.abs(marker.end - tmuxCursorX)).toBeLessThan(0.1);
      // The wide glyph must NOT have been grouped into the ASCII run (that is
      // how a glyph the renderer doesn't classify as wide shifts the line)…
      expect({ case: c.name, run: marker.text }).toEqual({
        case: c.name,
        run: expect.stringMatching(/^[ -~]+$/),
      });
      // …and the run's own text advances exactly one cell per character.
      expect(Math.abs(marker.ink - marker.text.length)).toBeLessThan(0.1);

      // 3. The wide glyph owns a 1-cell box on the grid but paints ~2 cells of
      //    ink, spilling into its continuation cell rather than shifting the line.
      const wide = await getRunGeometry(ctx.page, c.wideGlyph);
      expect(wide.visible).toBe(true);
      expect(Math.abs(wide.box - 1)).toBeLessThan(0.1);
      expect(wide.ink).toBeGreaterThan(1.2);
      expect(wide.ink).toBeLessThan(3);
      expect(Number.isInteger(Math.round(wide.start))).toBe(true);
      expect(Math.abs(wide.start - Math.round(wide.start))).toBeLessThan(0.1);

      // Release `read` and confirm the shell is back at a prompt on the grid.
      await pressEnter(ctx.page);
      await runCommand(ctx.page, `echo AFTER_${c.marker}`, `AFTER_${c.marker}`);
    }
  }, 180000);
});

// ==================== Scenario 16b: SGR 2 (faint/dim) ====================

describe('Scenario 16b: SGR 2 faint/dim attribute', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // Claude Code's TUI uses SGR 2 (faint) for its autosuggestion text. The
  // vt100 0.15 crate dropped SGR 2 on the floor, so dim text rendered as
  // normal-intensity white. After bumping to vt100 0.16 + threading
  // `cell.dim()` through CellStyle, the frontend renders dim cells at
  // reduced opacity.
  test('Faint text (SGR 2) is rendered at reduced opacity', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Emit DIM_TEXT in faint, BRIGHT_TEXT in normal intensity.
    await runCommand(ctx.page, 'printf "\\e[2mDIM_TEXT\\e[22m BRIGHT_TEXT\\n"', 'DIM_TEXT');
    await waitForTerminalText(ctx.page, 'BRIGHT_TEXT');

    // Locate the spans whose text *exactly* equals each marker — the
    // shell echoes the printf command back as one continuous prompt-line
    // span containing the literal "DIM_TEXT" / "BRIGHT_TEXT" substrings,
    // so a substring search would find that span first and miss the
    // actual rendered output below.
    const opacities = await ctx.page.evaluate(() => {
      const findExactSpan = (text) => {
        const spans = document.querySelectorAll('[role="log"] span');
        for (const s of spans) {
          if ((s.textContent || '').trim() === text) return s;
        }
        return null;
      };
      const readOpacity = (el) => {
        if (!el) return null;
        const inline = el.style.opacity;
        if (inline) return parseFloat(inline);
        const computed = getComputedStyle(el).opacity;
        return computed ? parseFloat(computed) : 1;
      };
      return {
        dim: readOpacity(findExactSpan('DIM_TEXT')),
        bright: readOpacity(findExactSpan('BRIGHT_TEXT')),
      };
    });

    expect(opacities.dim).not.toBeNull();
    expect(opacities.bright).not.toBeNull();
    expect(opacities.dim).toBeLessThan(1);
    expect(opacities.bright).toBe(1);
  }, 60000);
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

      await runCommand(
        ctx.page,
        'echo -e "\\e]8;;https://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"',
        'Click Here',
      );

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('Click Here');

      // OSC 8 hyperlinks render as real anchors (TerminalLine wraps runs
      // carrying a cell URL in <a href>). This is what distinguishes this
      // test from Scenario 14, which only checks the text; the old version
      // computed linkInfo and asserted nothing.
      const linkInfo = await ctx.page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('.terminal-content a[href]'));
        return {
          count: anchors.length,
          hrefs: anchors.map((a) => a.getAttribute('href')),
          visible: anchors.map((a) => {
            const r = a.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }),
        };
      });
      expect(linkInfo.count).toBeGreaterThan(0);
      expect(linkInfo.hrefs.some((h) => h && h.includes('example.com'))).toBe(true);
      // Rendered, not just present: the anchor must occupy space on screen.
      expect(linkInfo.visible.some(Boolean)).toBe(true);
    });

    test('clicking an OSC 8 link opens it; an auto-detected URL opens only with the modifier', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Links open through openExternalUrl (window.open on the web, the
      // desktop's open_url command in Tauri) — never through the anchor's own
      // navigation, which the desktop webview denies. Stub window.open so the
      // test observes the call instead of leaving the page.
      await ctx.page.evaluate(() => {
        window.__opened = [];
        window.open = (url, target, features) => {
          window.__opened.push({ url, target, features });
          return null;
        };
      });

      await runCommand(
        ctx.page,
        'echo -e "\\e]8;;https://example.com/osc\\e\\\\OSC-LINK\\e]8;;\\e\\\\ https://example.com/plain"',
        'OSC-LINK',
      );

      // Step 1: a plain click on the OSC 8 anchor opens it and the page stays.
      await ctx.page.click('.terminal-content a.terminal-hyperlink');
      await waitForCondition(
        ctx.page,
        async () => ctx.page.evaluate(() => window.__opened.length === 1),
        5000,
        'the OSC 8 link to be opened',
      );
      const first = await ctx.page.evaluate(() => window.__opened[0]);
      expect(first.url).toBe('https://example.com/osc');
      expect(first.target).toBe('_blank');
      expect(await ctx.page.evaluate(() => location.pathname)).toBe('/');

      // Step 2: the auto-detected URL is inert text until the platform link
      // modifier is held (Cmd on macOS, Ctrl elsewhere): pointer-events: none
      // keeps a plain click from reaching it.
      // The echoed command line also auto-links, so pick the output's URL by href.
      const autolink = '.terminal-content a.terminal-autolink[href="https://example.com/plain"]';
      await ctx.page.click(autolink, { force: true });
      await delay(DELAYS.MEDIUM);
      expect(await ctx.page.evaluate(() => window.__opened.length)).toBe(1);

      // Hold the modifier as a real keydown first: the body class that turns
      // pointer-events back on is set by the link modifier actor on keydown,
      // and Playwright's click checks hit-testing before it presses modifiers.
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await ctx.page.keyboard.down(modifier);
      await delay(DELAYS.SHORT);
      await ctx.page.click(autolink);
      await ctx.page.keyboard.up(modifier);
      await waitForCondition(
        ctx.page,
        async () => ctx.page.evaluate(() => window.__opened.length === 2),
        5000,
        'the auto-detected URL to be opened with the modifier held',
      );
      const second = await ctx.page.evaluate(() => window.__opened[1]);
      expect(second.url).toBe('https://example.com/plain');
    });

    test('Multiple hyperlinks on same line render correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(
        ctx.page,
        'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"',
        'LinkA',
      );

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('LinkA');
      expect(text).toContain('LinkB');

      const lines = text.split('\n');
      const linkLine = lines.find((line) => line.includes('LinkA') && line.includes('LinkB'));
      expect(linkLine).toBeDefined();
    });

    test('Terminal handles malformed OSC 8 gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo -e "\\e]8;;https://test.com\\e\\\\Unclosed"', 'Unclosed');

      await runCommand(ctx.page, 'echo "still_working"', 'still_working');
    });
  });

  // ====================
  // 11.2 Clipboard (OSC 52)
  // ====================
  describe('11.2 Clipboard (OSC 52)', () => {
    test('OSC 52 sequence does not crash terminal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(
        ctx.page,
        'echo -ne "\\e]52;c;dGVzdA==\\e\\\\"; echo "osc52_sent"',
        'osc52_sent',
      );

      await runCommand(ctx.page, 'echo "DONE"', 'DONE');
    });

    test('Multiple OSC 52 operations in sequence', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo -ne "\\e]52;c;Zmlyc3Q=\\e\\\\"; echo "osc1"', 'osc1');
      await runCommand(ctx.page, 'echo -ne "\\e]52;c;c2Vjb25k\\e\\\\"; echo "osc2"', 'osc2');
      await runCommand(ctx.page, 'echo -ne "\\e]52;c;dGhpcmQ=\\e\\\\"; echo "osc3"', 'osc3');

      await runCommand(ctx.page, 'echo "sequence_done"', 'sequence_done');
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
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

  /**
   * Helper: get image placements from XState context for the active pane
   */
  async function getImagePlacements(page) {
    return page.evaluate(() => {
      const snap = window.app?.getSnapshot?.();
      if (!snap) return [];
      const ctx = snap.context;
      const activePaneId = ctx.activePaneId;
      const pane = ctx.panes?.find((p) => p.tmuxId === activePaneId);
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
    await runCommand(ctx.page, cmd, 'IMG_SENT');

    // Verify the output marker is present (the printf command text may appear in prompt)
    const text = await getTerminalText(ctx.page);
    expect(text).toContain('IMG_SENT');

    // Verify image placement appears in state
    const images = await waitForImages(ctx.page);
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images[0].protocol).toBe('iterm2');
    expect(images[0].widthCells).toBe(10);
    expect(images[0].heightCells).toBe(5);

    // Verify <img> element rendered AND visible — an element in the DOM but
    // clipped to zero size is not an image the user can see (TESTS.md).
    const imgInfo = await ctx.page.evaluate(() => {
      const img = document.querySelector('.terminal-image');
      if (!img) return null;
      const r = img.getBoundingClientRect();
      return { src: img.src, tagName: img.tagName, width: r.width, height: r.height };
    });
    expect(imgInfo).not.toBeNull();
    expect(imgInfo.tagName).toBe('IMG');
    expect(imgInfo.src).toContain('/api/images/');
    expect(imgInfo.width).toBeGreaterThan(0);
    expect(imgInfo.height).toBeGreaterThan(0);
  }, 60000);

  test('iTerm2 non-inline file download is ignored (no placement)', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // File download (no inline=1) — should be consumed but produce no image
    const cmd = `printf '\\e]1337;File=name=dGVzdA==:${TINY_PNG_B64}\\a' && echo DOWNLOAD_SENT`;
    await runCommand(ctx.page, cmd, 'DOWNLOAD_SENT');

    await delay(DELAYS.SYNC * 2);

    const images = await getImagePlacements(ctx.page);
    expect(images.length).toBe(0);
  }, 60000);

  test('Kitty graphics protocol (APC _G, f=100 PNG): placement + img rendered', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Kitty graphics: ESC _ G <keys> ; <payload> ESC \
    // Single-chunk, f=100 (PNG direct), c=12 cols, r=4 rows, i=42 image id.
    const cmd = `printf '\\e_Ga=T,f=100,c=12,r=4,i=42;${TINY_PNG_B64}\\e\\\\' && echo KITTY_SENT`;
    await runCommand(ctx.page, cmd, 'KITTY_SENT');

    const images = await waitForImages(ctx.page);
    const kitty = images.find((img) => img.protocol === 'kitty');
    expect(kitty).toBeDefined();
    expect(kitty.widthCells).toBe(12);
    expect(kitty.heightCells).toBe(4);

    // <img> rendered with data-protocol="kitty" AND occupying screen space.
    const kittyEls = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll('.terminal-image')).map((el) => {
        const r = el.getBoundingClientRect();
        return { protocol: el.getAttribute('data-protocol'), visible: r.width > 0 && r.height > 0 };
      }),
    );
    expect(kittyEls.some((e) => e.protocol === 'kitty' && e.visible)).toBe(true);
  }, 60000);

  test('Sixel (DCS Pq): placement created from a real-decoded bitmap', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Minimal valid Sixel: 1 color palette, one band of six pixels per
    // column. Format: ESC P q #0;2;100;0;0 #0 ~~~ ESC \\
    //   #0;2;<r>;<g>;<b>  registers palette entry 0 (RGB scale 0-100)
    //   #0                selects color 0
    //   ~                 sixel char with all 6 vertical bits set
    const cmd = `printf '\\ePq#0;2;100;0;0#0~~~\\e\\\\' && echo SIXEL_SENT`;
    await runCommand(ctx.page, cmd, 'SIXEL_SENT');

    // Unconditional: the core unit test (images.rs sixel_decoded_to_png)
    // proves this exact toy input decodes, so a missing placement here is a
    // real regression. The old `if (sixel)` guard let a total sixel-decode
    // failure pass green.
    const images = await waitForImages(ctx.page);
    const sixel = images.find((img) => img.protocol === 'sixel');
    expect(sixel).toBeDefined();
    expect(sixel.widthCells).toBeGreaterThanOrEqual(1);
    expect(sixel.heightCells).toBeGreaterThanOrEqual(1);
    const sixelEls = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll('.terminal-image')).map((el) => {
        const r = el.getBoundingClientRect();
        return { protocol: el.getAttribute('data-protocol'), visible: r.width > 0 && r.height > 0 };
      }),
    );
    expect(sixelEls.some((e) => e.protocol === 'sixel' && e.visible)).toBe(true);

    // Either way, the terminal must remain usable.
    await runCommand(ctx.page, 'echo AFTER_SIXEL', 'AFTER_SIXEL');
  }, 60000);

  test('Mixed content: text + image + text renders correctly', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Send text, then image, then more text
    const cmd = `echo BEFORE_IMG && printf '\\e]1337;File=inline=1;width=5;height=3:${TINY_PNG_B64}\\a' && echo AFTER_IMG`;
    await runCommand(ctx.page, cmd, 'AFTER_IMG');

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
    await runCommand(ctx.page, cmd, 'HTTP_TEST');

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
const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// 1x1 blue PNG, base64-encoded
const BLUE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

// 1x1 green PNG, base64-encoded
const GREEN_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  return page.waitForFunction((sel) => document.querySelector(sel) !== null, selector, {
    timeout,
    polling: 200,
  });
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

      await sendWidgetCommand(wCtx.page, `(echo "${RED_PNG}"; sleep 999) | ${TMUXY_WIDGET} image`);

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

      await sendWidgetCommand(
        wCtx.page,
        `(echo "${RED_PNG}"; sleep 1; echo "${BLUE_PNG}"; sleep 1; echo "${GREEN_PNG}"; sleep 999) | ${TMUXY_WIDGET} image`,
      );

      await waitForDomSelector(wCtx.page, '.widget-image', 30000);

      const greenSignature = GREEN_PNG.slice(-30);
      await wCtx.page.waitForFunction(
        (sig) => {
          const img = document.querySelector('.widget-image img');
          return img && img.src && img.src.includes(sig);
        },
        greenSignature,
        { timeout: 30000, polling: 300 },
      );

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

      await sendWidgetCommand(wCtx.page, 'echo "hello world"');
      await waitForTerminalText(wCtx.page, 'hello world');

      const hasTerminal = await wCtx.page.evaluate(
        () => document.querySelector('[role="log"]') !== null,
      );
      expect(hasTerminal).toBe(true);

      const hasWidget = await wCtx.page.evaluate(
        () => document.querySelector('.widget-image') !== null,
      );
      expect(hasWidget).toBe(false);
    });

    test('Unregistered widget name falls back to Terminal', async () => {
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      await sendWidgetCommand(wCtx.page, `echo "test" | ${TMUXY_WIDGET} nonexistent_xyz`);

      await delay(2000);

      const hasTerminal = await wCtx.page.evaluate(
        () => document.querySelector('[role="log"]') !== null,
      );
      expect(hasTerminal).toBe(true);

      const hasWidget = await wCtx.page.evaluate(
        () => document.querySelector('.widget-image') !== null,
      );
      expect(hasWidget).toBe(false);
    });
  });
});
