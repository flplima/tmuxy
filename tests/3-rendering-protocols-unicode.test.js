/**
 * Rendering & Protocols E2E Tests (Unicode & SGR 2)
 *
 * Unicode rendering (box drawing, CJK, emoji, wide glyph cell grid) and SGR 2 faint/dim attribute.
 */

const {
  createTestContext,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  typeInTerminal,
  pressEnter,
  getCellWidth,
  getCursorGeometry,
  getRunGeometry,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

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
        name: 'VS16',
        // ☑️ = ballot box + VS16: a narrow symbol that tmux widens to two cells
        // (variation-selector-always-wide). The renderer used to keep it at one.
        bytes: '\\xe2\\x98\\x91\\xef\\xb8\\x8f',
        wideGlyph: '\u2611\ufe0f',
        marker: 'END_VS16_GRID',
      },
      {
        name: 'flag',
        // 🇺🇸 = two regional indicators: one 2-cell glyph
        bytes: '\\xf0\\x9f\\x87\\xba\\xf0\\x9f\\x87\\xb8',
        wideGlyph: '\u{1f1fa}\u{1f1f8}',
        marker: 'END_FLAG_GRID',
      },
    ];

    // tmux before 3.4 gives ZWJ, skin-tone and VS16 sequences other widths,
    // which tmuxy does not follow — a documented limitation (docs/TMUX.md,
    // tmux version table). On those versions only the rules both agree on are
    // checked.
    const [major, minor] = (tmuxExec('-V').match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
    const sameRules = !major || major > 3 || (major === 3 && minor >= 4);
    const checked = sameRules
      ? cases
      : cases.filter((c) => !['ZWJ sequence', 'skin tone', 'VS16'].includes(c.name));
    for (const c of checked) {
      await typeInTerminal(
        ctx.page,
        `printf "${c.name.slice(0, 3)} ${c.bytes} ${c.marker}"; read -r _`,
      );
      await pressEnter(ctx.page);
      // The typed command line also carries the marker; the output line is
      // the one without `printf`, and `read` parks tmux's cursor right after it.
      await waitForTerminalText(ctx.page, c.marker, 15000, { notOnLineWith: 'printf' });
      await ctx.session.waitForCursorLine(new RegExp(`${c.marker}$`));

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

  test('A wide glyph on a coloured row keeps the row colour and is drawn above the next cell', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // An editor's cursor line is a coloured row. Two things went wrong on it:
    // the second column of a wide glyph came out in the default background (a
    // black hole beside every ✅), and the next cell's background was painted
    // over the glyph's right half (a cropped ☑️). The row is printed with a
    // background so both are visible, then parked in `read`.
    await typeInTerminal(
      ctx.page,
      'printf "\\033[48;5;237mBGW \\xe2\\x9c\\x85X \\xe2\\x98\\x91\\xef\\xb8\\x8f END_BG_WIDE\\033[0m"; read -r _',
    );
    await pressEnter(ctx.page);
    // The typed command carries the marker too; `read` parks tmux's cursor
    // right after the printed one.
    await waitForTerminalText(ctx.page, 'END_BG_WIDE', 15000, { notOnLineWith: 'printf' });
    await ctx.session.waitForCursorLine(/END_BG_WIDE$/);

    const row = await ctx.page.evaluate(() => {
      const spans = [...document.querySelectorAll('.terminal-line > span')];
      const report = (glyph) => {
        const span = spans.find((s) => s.textContent === glyph);
        if (!span) return null;
        const next = span.nextElementSibling;
        const cs = getComputedStyle(span);
        return {
          bg: cs.backgroundColor,
          nextBg: next ? getComputedStyle(next).backgroundColor : null,
          lifted: cs.position === 'relative' && Number(cs.zIndex) > 0,
          nextZ: next ? getComputedStyle(next).zIndex : null,
        };
      };
      return { check: report('\u2705'), ballot: report('\u2611\ufe0f') };
    });

    // ✅ is two columns: its second column is the row's colour, not a hole.
    expect(row.check).not.toBeNull();
    expect(row.check.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(row.check.nextBg).toBe(row.check.bg);
    // Both glyphs paint above the cell they spill into.
    expect(row.check.lifted).toBe(true);
    expect(row.check.nextZ).toBe('auto');
    expect(row.ballot).not.toBeNull();
    expect(row.ballot.lifted).toBe(true);

    await pressEnter(ctx.page);
    await runCommand(ctx.page, 'echo AFTER_BG_WIDE', 'AFTER_BG_WIDE');
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
