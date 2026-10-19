/**
 * Rendering & Protocols E2E Tests (OSC Protocols)
 *
 * OSC protocols: hyperlinks, clipboard, pane titles.
 */

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

    // Step 1: OSC 8 hyperlink renders text as a real, visible anchor
    await runCommand(
      ctx.page,
      'echo -e "\\e]8;;http://example.com\\e\\\\Click Here\\e]8;;\\e\\\\"',
      'Click Here',
    );

    // TerminalLine wraps runs carrying a cell URL in <a href>. The anchor must
    // occupy space on screen, not merely exist in the DOM.
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
    expect(
      linkInfo.hrefs.some((h) => {
        if (!h) return false;
        try {
          const parsed = new URL(h);
          return (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            parsed.hostname === 'example.com'
          );
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    expect(linkInfo.visible.some(Boolean)).toBe(true);

    // Step 2: Multiple links
    await runCommand(
      ctx.page,
      'echo -e "\\e]8;;http://a.com\\e\\\\LinkA\\e]8;;\\e\\\\ \\e]8;;http://b.com\\e\\\\LinkB\\e]8;;\\e\\\\"',
      'LinkA',
    );
    await waitForTerminalText(ctx.page, 'LinkB');
    const multiLinkText = await getTerminalText(ctx.page);
    const linkLine = multiLinkText
      .split('\n')
      .find((line) => line.includes('LinkA') && line.includes('LinkB'));
    expect(linkLine).toBeDefined();

    // Step 3: Malformed OSC 8 - terminal should survive
    await typeInTerminal(ctx.page, 'echo -e "\\e]8;;http://broken.com\\e\\\\BROKEN_LINK"');
    await pressEnter(ctx.page);
    await runCommand(ctx.page, 'echo "AFTER_MALFORMED"', 'AFTER_MALFORMED', 15000);

    // Step 4: OSC 52 doesn't crash
    // The shell runs these in the order typed, so the echo after them is the
    // fence: its output only shows once the OSC 52 lines have gone through.
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;SGVsbG8=\\e\\\\"');
    await pressEnter(ctx.page);
    await runCommand(ctx.page, 'echo "OSC52_OK"', 'OSC52_OK');

    // Step 5: Multiple OSC 52 operations
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;Zmlyc3Q=\\e\\\\"');
    await pressEnter(ctx.page);
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;c2Vjb25k\\e\\\\"');
    await pressEnter(ctx.page);
    await typeInTerminal(ctx.page, 'echo -ne "\\e]52;c;dGhpcmQ=\\e\\\\"');
    await pressEnter(ctx.page);
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

    // Whatever the header shows before any program has announced a title: the
    // process name on a bare shell, or the shell's own title where the user's
    // rc file sets one (`zsh | tmuxy` and friends — plenty of prompts do).
    // Either is correct, and the assertion is the negative the header exists
    // for: it must never be the HOST NAME tmux seeds every `pane_title` with,
    // and it must be something really drawn.
    // `list-panes`, not `display-message`: the query helper appends its own
    // `-t <session>`, which display-message refuses as a second argument.
    const host = String(await ctx.session.query("list-panes -F '#{host}'"))
      .split('\n')[0]
      .trim();
    const idle = await readHeaderTitle();
    expect(idle).not.toBeNull();
    expect(idle.text).not.toBe('');
    expect(idle.text).not.toBe(host);
    expect(idle.width).toBeGreaterThan(0);
    expect(idle.height).toBeGreaterThan(0);

    // A program that announces NO title is named by its process: the header
    // falls back to `pane_current_command`, and follows it back to the shell
    // when the program exits. A pane-group member's label used to keep saying
    // `sleep` after Ctrl+C, because the hidden window it lives in was polled
    // for its metadata and the exit fell between polls. The title is cleared
    // first so a shell whose rc file sets one does not mask the fallback.
    await typeInTerminal(ctx.page, 'printf "\\033]2;\\007"; sleep 30');
    await pressEnter(ctx.page);
    const running = await waitForHeaderTitle('sleep');
    expect(running.width).toBeGreaterThan(0);
    await sendKeyCombo(ctx.page, 'Control', 'c');
    await waitForShellPrompt(ctx.page);
    await waitForHeaderTitle(idle.text);

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
