/**
 * Rendering & Protocols E2E Tests (Links)
 *
 * OSC 8 hyperlinks and auto-detected URLs: opening them, a URL that wraps —
 * the terminal's wrap or the program's — and a link repainted over.
 */

const { afterFrames, createTestContext, runCommand, waitForCondition } = require('./helpers');

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

      // Step 1: the OSC 8 anchor is drawn over its own text. A link recorded
      // against the wrong cells once carried the right href on the next
      // line's text, which an href alone cannot tell apart.
      const readAnchor = () =>
        ctx.page.evaluate(() => {
          const a = document.querySelector('.terminal-content a.terminal-hyperlink');
          const r = a?.getBoundingClientRect();
          return a && { text: a.textContent, href: a.getAttribute('href'), shown: r.width > 0 };
        });
      await waitForCondition(
        ctx.page,
        async () => (await readAnchor()) !== null,
        5000,
        'the OSC 8 anchor to be drawn',
      );
      const anchor = await readAnchor();
      expect(anchor).toEqual({ text: 'OSC-LINK', href: 'https://example.com/osc', shown: true });

      // A plain click on it opens it and the page stays.
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
      // A click is handled in the page: had it opened the link, it would have
      // within a frame or two.
      await afterFrames(ctx.page);
      expect(await ctx.page.evaluate(() => window.__opened.length)).toBe(1);

      // Hold the modifier as a real keydown first: the body class that turns
      // pointer-events back on is set by the link modifier actor on keydown,
      // and Playwright's click checks hit-testing before it presses modifiers.
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await ctx.page.keyboard.down(modifier);
      await waitForCondition(
        ctx.page,
        () => ctx.page.evaluate(() => document.body.classList.contains('link-modifier-held')),
        5000,
        'the held modifier to make links clickable',
      );
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

      // Step 3: a URL longer than the pane wraps onto a second row. Detected
      // per row it was a link to the first row's fragment and plain text
      // after that; both rows are one link to the whole address, and the
      // second row opens it. The path is built so the typed command does not
      // itself hold the URL.
      const long = `https://example.com/wrap/${'a'.repeat(200)}?x=1`;
      await runCommand(
        ctx.page,
        `echo "https://example.com/wrap/$(printf 'a%.0s' {1..200})?x=1"`,
        'aaaa?x=1',
      );
      const fragments = await ctx.page.evaluate((href) => {
        const anchors = [...document.querySelectorAll('.terminal-content a.terminal-autolink')]
          .filter((a) => a.getAttribute('href') === href)
          .map((a) => a.getBoundingClientRect());
        return anchors.map((r) => ({ top: r.top, width: r.width, height: r.height }));
      }, long);
      // More than one row, each a visible box, all with the full href.
      expect(fragments.length).toBeGreaterThan(1);
      for (const f of fragments) expect(f.width).toBeGreaterThan(0);
      expect(new Set(fragments.map((f) => Math.round(f.top))).size).toBe(fragments.length);

      // Hovering the first fragment marks every row of the link, not only the
      // one under the pointer.
      await ctx.page.keyboard.down(modifier);
      await waitForCondition(
        ctx.page,
        async () => ctx.page.evaluate(() => document.body.classList.contains('link-modifier-held')),
        5000,
        'the link modifier to be held',
      );
      const firstFragment = ctx.page
        .locator(`.terminal-content a.terminal-autolink[href="${long}"]`)
        .first();
      await firstFragment.hover();
      const hot = await ctx.page.evaluate(
        (href) =>
          [...document.querySelectorAll('.terminal-content a.terminal-autolink')]
            .filter((a) => a.getAttribute('href') === href)
            .map((a) => a.classList.contains('terminal-link-hot')),
        long,
      );
      expect(hot.length).toBe(fragments.length);
      expect(hot.every(Boolean)).toBe(true);

      // The last row opens the whole URL.
      await ctx.page
        .locator(`.terminal-content a.terminal-autolink[href="${long}"]`)
        .last()
        .click();
      await ctx.page.keyboard.up(modifier);
      await waitForCondition(
        ctx.page,
        async () => ctx.page.evaluate(() => window.__opened.length === 3),
        5000,
        'the wrapped URL to be opened from its last row',
      );
      expect(await ctx.page.evaluate(() => window.__opened[2].url)).toBe(long);

      // Step 4: a URL the PROGRAM wrapped — Claude Code, agy and other TUIs
      // break a long line themselves, short of the pane's edge, and indent
      // the rest — so neither row fills the pane. Its first row ends two
      // columns from the edge here, and both rows are still one link.
      const width = await ctx.page.evaluate(() => {
        const { panes, activePaneId } = window.app.getSnapshot().context;
        return panes.find((p) => p.tmuxId === activePaneId).width;
      });
      const head = 'see https://example.com/hard/';
      const bs = width - head.length - 2;
      const hard = `https://example.com/hard/${'b'.repeat(bs)}${'c'.repeat(20)}?y=2`;
      await runCommand(
        ctx.page,
        `clear; printf 'see https://example.com/hard/%s\\n  %s?y=2\\n' "$(printf 'b%.0s' {1..${bs}})" "$(printf 'c%.0s' {1..20})"`,
        'ccc?y=2',
      );
      const hardRows = await ctx.page.evaluate(
        (href) =>
          [...document.querySelectorAll('.terminal-content a.terminal-autolink')]
            .filter((a) => a.getAttribute('href') === href)
            .map((a) => Math.round(a.getBoundingClientRect().top)),
        hard,
      );
      expect(new Set(hardRows).size).toBe(2);
      await ctx.page.keyboard.down(modifier);
      await ctx.page
        .locator(`.terminal-content a.terminal-autolink[href="${hard}"]`)
        .last()
        .click();
      await ctx.page.keyboard.up(modifier);
      await waitForCondition(
        ctx.page,
        async () => ctx.page.evaluate(() => window.__opened.length === 4),
        5000,
        'the program-wrapped URL to be opened from its second row',
      );
      expect(await ctx.page.evaluate(() => window.__opened[3].url)).toBe(hard);
    });

    // The reported bug: a long underline over unrelated text in Claude Code.
    // A hyperlink is recorded against the cells it painted, and an
    // application that repaints in place scrolls nothing and clears nothing —
    // so the link's coordinates outlived its text and the next frame's
    // characters inherited them. One `echo` does the whole thing: open the
    // link (BEL-terminated, so the CR that follows is unambiguous), write the
    // label, carriage-return back over it, repaint. Nothing about the pane
    // moves, which is exactly the case that used to slip through.
    test('a link repainted over does not leave its highlight on the new text', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // A link on its own is an anchor — the control the rest of this test needs.
      await runCommand(
        ctx.page,
        'echo -e "\\x1b]8;;http://ex.test/live\\x07LIVE-LINK\\x1b]8;;\\x07"',
        'LIVE-LINK',
      );
      // The typed command line holds the label too, so the text being on
      // screen says nothing about the output yet: wait for the anchor itself.
      const liveAnchors = () =>
        ctx.page.evaluate(() =>
          Array.from(document.querySelectorAll('.terminal-content a.terminal-hyperlink'))
            .filter((a) => a.getAttribute('href') === 'http://ex.test/live')
            .map((a) => a.textContent),
        );
      await waitForCondition(
        ctx.page,
        async () => (await liveAnchors()).includes('LIVE-LINK'),
        10000,
        async () =>
          `the live link to be an anchor (anchors: ${JSON.stringify(await liveAnchors())})`,
      );

      // Now the repaint: same cells, different text, no scroll and no clear.
      // ZZZZZZZZ is one cell wider than CLICKME, so every marked cell changes.
      await runCommand(
        ctx.page,
        'echo -e "\\x1b]8;;http://ex.test/stale\\x07CLICKME\\x1b]8;;\\x07\\rZZZZZZZZ"',
        'ZZZZZZZZ',
      );
      await runCommand(ctx.page, 'echo REPAINT_RENDERED', 'REPAINT_RENDERED');

      const repainted = await ctx.page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('.terminal-content a[href]'));
        return {
          // The repainted characters must not sit inside any link.
          overNewText: anchors
            .filter((a) => a.textContent.includes('Z'))
            .map((a) => ({ text: a.textContent, href: a.getAttribute('href'), cls: a.className })),
          // And the OSC 8 link itself is gone: its label is no longer on screen.
          // (The echoed command line still shows the URL as plain text, which
          // auto-links — inert, and a different class.)
          staleHyperlinks: anchors
            .filter(
              (a) =>
                a.classList.contains('terminal-hyperlink') &&
                a.getAttribute('href') === 'http://ex.test/stale',
            )
            .map((a) => a.textContent),
          text: document.querySelector('.terminal-content').textContent,
        };
      });

      expect(repainted.text).toContain('ZZZZZZZZ');
      expect(repainted.overNewText).toEqual([]);
      expect(repainted.staleHyperlinks).toEqual([]);
    });
  });
});
