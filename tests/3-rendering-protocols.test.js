/**
 * Rendering & Protocols E2E Tests (OSC Protocols & Widgets)
 *
 * OSC protocols (hyperlinks, clipboard, pane titles) and browser/image widgets.
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
  waitForCondition,
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

// ==================== Widget Tests ====================

// 1x1 red PNG, base64-encoded
const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

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

// Resolve the CLI and the raw widget wrapper relative to this file (works in
// both dev and CI).
const TMUXY_CLI = path.resolve(__dirname, '..', 'bin/tmuxy-cli');
const TMUXY_WIDGET = path.resolve(__dirname, '..', 'bin/tmuxy/tmuxy-widget');

/** Geometry + text of the browser widget's first rendered heading. */
function readHeading(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.widget-markdown h1');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { text: el.textContent, width: rect.width, height: rect.height, top: rect.top };
  });
}

describe('Category 17: Widgets', () => {
  const wCtx = createTestContext();
  beforeAll(wCtx.beforeAll, wCtx.hookTimeout);
  afterAll(wCtx.afterAll);
  beforeEach(wCtx.beforeEach);
  afterEach(wCtx.afterEach, wCtx.hookTimeout);

  // ====================
  // 17.1 Browser Widget: a markdown file, its pane menu, and closing it
  // ====================
  describe('17.1 Browser Widget', () => {
    test('Renders a markdown file, names the pane after it, zooms from the pane menu, and closes back to a shell', async () => {
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      const file = `/tmp/tmuxy-browser-e2e-${Date.now()}.md`;
      await sendWidgetCommand(
        wCtx.page,
        `printf '# BROWSER_WIDGET_MD\\n\\nbody text\\n' > ${file}; ${TMUXY_CLI} widget browser ${file}`,
      );

      // The file's content is rendered as a document — not printed as source,
      // and not merely present in the DOM: the heading must have real area.
      await waitForDomSelector(wCtx.page, '.widget-markdown h1', 30000);
      const heading = await readHeading(wCtx.page);
      expect(heading.text).toBe('BROWSER_WIDGET_MD');
      expect(heading.width).toBeGreaterThan(0);
      expect(heading.height).toBeGreaterThan(0);

      // The pane names itself after the document's first heading, as a page
      // is named after its `<title>`, and wears the browser widget's globe
      // rather than a shell icon.
      const readTab = () =>
        wCtx.page.evaluate(() => {
          const pane = document.querySelector('[role=group][aria-label^="Widget pane"]');
          return {
            title: pane?.querySelector('.pane-tab-title')?.textContent ?? null,
            icon: pane?.querySelector('.pane-tab-icon')?.textContent ?? null,
            hasTerminal: pane?.querySelector('[role="log"]') !== null,
          };
        });
      await waitForCondition(
        wCtx.page,
        async () => (await readTab()).title === 'BROWSER_WIDGET_MD',
        15000,
        async () =>
          `the pane to be named after its heading (now ${JSON.stringify(await readTab())})`,
      );
      const tab = await readTab();
      expect(tab.icon).toBe('\uf0ac'); // nf-fa-globe
      expect(tab.hasTerminal).toBe(false);

      // The navigation bar runs the whole width of the pane: the widget pane
      // drops the terminal's side padding, so no strip of pane background is
      // left showing beside the toolbar.
      const bar = await wCtx.page.evaluate(() => {
        const pane = document.querySelector('[role=group][aria-label^="Widget pane"]');
        const nav = pane.querySelector('[data-testid="browser-nav"]').getBoundingClientRect();
        const body = pane.querySelector('.pane-content').getBoundingClientRect();
        return { left: nav.left - body.left, right: body.right - nav.right, width: nav.width };
      });
      expect(bar.width).toBeGreaterThan(0);
      expect(Math.abs(bar.left)).toBeLessThan(2);
      expect(Math.abs(bar.right)).toBeLessThan(2);

      // The ⋮ menu carries the browser's own section; Zoom In visibly enlarges
      // the rendered document.
      await wCtx.page.evaluate(() => {
        const pane = document.querySelector('[role=group][aria-label^="Widget pane"]');
        pane.querySelector('.pane-header-menu').click();
      });
      const menu = await wCtx.page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        // The widget's items lead the menu, ahead of the generic pane ones.
        return { leading: items.slice(0, 5).map((el) => el.textContent.trim()) };
      });
      expect(menu.leading.map((label) => label.replace(/ctrl\+[a-z]$/, ''))).toEqual([
        'Zoom In',
        'Zoom Out',
        'Copy Current URL',
        'Refresh',
        'Close Browser',
      ]);

      await wCtx.page.evaluate(() => {
        [...document.querySelectorAll('[role="menuitem"]')]
          .find((el) => el.textContent.trim() === 'Zoom In')
          .click();
      });
      // Zooming a rendered document grows the type, so the heading's line box
      // gets taller — its width is the pane's and would not move.
      await waitForCondition(
        wCtx.page,
        async () => (await readHeading(wCtx.page)).height > heading.height,
        10000,
        'the zoomed heading to grow',
      );

      // Closing the browser ends the widget process and hands the pane back to
      // a working shell.
      await sendKeyCombo(wCtx.page, 'Control', 'c');
      await waitForCondition(
        wCtx.page,
        () => wCtx.page.evaluate(() => document.querySelector('.widget-browser') === null),
        20000,
        'the browser widget to close',
      );
      await sendWidgetCommand(wCtx.page, 'echo AFTER_BROWSER_WIDGET');
      await waitForTerminalText(wCtx.page, 'AFTER_BROWSER_WIDGET');
    }, 120000);

    test('--color-filter recolours a page into the theme and closes back to a shell [nightly]', async () => {
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      // A page with its own palette: black text on white paper.
      const file = `/tmp/tmuxy-browser-filter-${Date.now()}.html`;
      await sendWidgetCommand(
        wCtx.page,
        `printf '<body style="background:#fff;color:#000"><h1>FILTER_PAGE</h1></body>' > ${file}; ${TMUXY_CLI} widget browser --color-filter ${file}`,
      );
      await waitForDomSelector(wCtx.page, '.widget-browser-frame', 30000);

      // The page is recoloured by a tint sheet laid over the frame: a
      // `filter` on the iframe itself only repaints the element's own
      // background, never the framed document. The filter's ramp is
      // the theme's three tones ordered DARKEST FIRST — which is what keeps a
      // page's polarity: luminance 0 (this page's black text) lands on the
      // theme's darkest tone, not on its foreground. Ordering by role instead
      // inverted every page on a dark theme.
      const filter = await wCtx.page.evaluate(() => {
        const frame = document.querySelector('.widget-browser-frame');
        const tint = document.querySelector('[data-testid="browser-color-filter"]');
        const svgFilter = document.querySelector('filter[id^="tmuxy-theme-filter-"]');
        const probe = document.createElement('span');
        document.body.appendChild(probe);
        const tone = (name) => {
          probe.style.color = `var(${name})`;
          const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g).map(Number);
          return { r, g, b, luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b };
        };
        const want = ['--term-foreground', '--term-bright-black', '--term-background']
          .map(tone)
          .sort((a, b) => a.luminance - b.luminance)
          .map((stop) => Number((stop.r / 255).toFixed(4)));
        probe.remove();
        const frameRect = frame?.getBoundingClientRect();
        const tintRect = tint?.getBoundingClientRect();
        return {
          css: tint ? getComputedStyle(tint).backdropFilter : null,
          covers:
            frameRect && tintRect
              ? Math.abs(tintRect.width - frameRect.width) < 2 &&
                Math.abs(tintRect.height - frameRect.height) < 2
              : false,
          id: svgFilter?.id ?? null,
          red: svgFilter?.querySelector('feFuncR')?.getAttribute('tableValues') ?? null,
          want,
        };
      });
      expect(filter.id).not.toBeNull();
      expect(filter.css).toContain(`#${filter.id}`);
      expect(filter.covers).toBe(true);
      expect(filter.red.split(' ').map(Number)).toEqual(filter.want);
      // ...and the ramp really does run dark to light, so the page is
      // recoloured rather than inverted.
      const redStops = filter.red.split(' ').map(Number);
      expect(redStops[0]).toBeLessThanOrEqual(redStops[redStops.length - 1]);

      await sendKeyCombo(wCtx.page, 'Control', 'c');
      await waitForCondition(
        wCtx.page,
        () => wCtx.page.evaluate(() => document.querySelector('.widget-browser') === null),
        20000,
        'the browser widget to close',
      );
    }, 120000);

    test('Renders an image source as a real picture', async () => {
      if (wCtx.skipIfNotReady()) return;
      await wCtx.setupPage();

      await sendWidgetCommand(
        wCtx.page,
        `{ echo "__SRC__:${RED_PNG}"; sleep 999; } | ${TMUXY_WIDGET} browser`,
      );

      await waitForDomSelector(wCtx.page, '.widget-browser-image img', 30000);
      const img = await wCtx.page.evaluate(() => {
        const el = document.querySelector('.widget-browser-image img');
        const rect = el.getBoundingClientRect();
        return {
          src: el.getAttribute('src'),
          decoded: el.naturalWidth > 0,
          width: rect.width,
          height: rect.height,
        };
      });
      expect(img.src).toContain('data:image/png;base64,');
      // Decoded and drawn, not a broken-image placeholder.
      expect(img.decoded).toBe(true);
      expect(img.width).toBeGreaterThan(0);
      expect(img.height).toBeGreaterThan(0);
    }, 90000);
  });
});
