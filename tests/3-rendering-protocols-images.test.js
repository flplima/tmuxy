/**
 * Rendering & Protocols E2E Tests (Terminal Image Protocols & Detailed OSC)
 *
 * iTerm2, Kitty, Sixel inline images, and detailed OSC 8 hyperlink behavior.
 */

const {
  afterFrames,
  createTestContext,
  delay,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  waitForCondition,
} = require('./helpers');

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

  test('iTerm2 inline image: sequence stripped, placement created, img rendered and served', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Text, then the iTerm2 inline image sequence, then more text — a picture
    // in the middle of a stream must not swallow the lines around it.
    // Format: ESC ] 1337 ; File=inline=1;width=10;height=5:<base64> BEL
    const cmd = `echo BEFORE_IMG && printf '\\e]1337;File=inline=1;width=10;height=5:${TINY_PNG_B64}\\a' && echo IMG_SENT`;
    await runCommand(ctx.page, cmd, 'IMG_SENT');

    // Verify both markers are present (the printf command text may appear in prompt)
    await waitForTerminalText(ctx.page, 'BEFORE_IMG');
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

    // The <img> src has to resolve: the endpoint serves the real PNG bytes,
    // and an id that was never stored is a 404, not an empty 200.
    const paneId = await ctx.page.evaluate(() => {
      const snap = window.app?.getSnapshot?.();
      return snap?.context?.activePaneId?.replace('%', '') || '';
    });
    const served = await ctx.page.evaluate(async (url) => {
      const resp = await fetch(url);
      return {
        status: resp.status,
        contentType: resp.headers.get('content-type'),
        size: (await resp.blob()).size,
      };
    }, `/api/images/${paneId}/${images[0].id}`);
    expect(served.status).toBe(200);
    expect(served.contentType).toContain('image/png');
    expect(served.size).toBeGreaterThan(0);

    const missing = await ctx.page.evaluate(async () => {
      const resp = await fetch('/api/images/999/999');
      return resp.status;
    });
    expect(missing).toBe(404);
  }, 60000);

  test('iTerm2 non-inline file download is ignored (no placement)', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // File download (no inline=1) — should be consumed but produce no image
    const cmd = `printf '\\e]1337;File=name=dGVzdA==:${TINY_PNG_B64}\\a' && echo DOWNLOAD_SENT`;
    // The echo's output comes after the escape in the pane's own byte stream,
    // so once it shows, any placement the escape made would already be there.
    await runCommand(ctx.page, cmd, 'DOWNLOAD_SENT');

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

  test('A terminal query is not a picture, and clear takes a picture away', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const pictures = () =>
      ctx.page.evaluate(
        () =>
          Array.from(document.querySelectorAll('.terminal-image')).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).length,
      );

    // 1. nvim asks the terminal about its capabilities with XTGETTCAP when it
    //    starts: a DCS string with a `q` in it, which used to be decoded as a
    //    Sixel picture and left a black bar on the editor's first line.
    await runCommand(
      ctx.page,
      `printf '\\eP+q5463;524742\\e\\\\' && echo QUERY_SENT`,
      'QUERY_SENT',
    );
    // The echo's output follows the query in the pane's byte stream: a picture
    // decoded from it would already be placed.
    expect(await pictures()).toBe(0);

    // 2. A real picture still shows...
    await runCommand(
      ctx.page,
      `printf '\\ePq#0;2;100;0;0#0~~~\\e\\\\' && echo PIC_SENT`,
      'PIC_SENT',
    );
    await waitForImages(ctx.page);
    expect(await pictures()).toBeGreaterThan(0);

    // 3. ...and `clear` takes it away with the text, instead of leaving it
    //    floating over whatever is drawn next.
    await runCommand(ctx.page, 'clear && echo CLEARED', 'CLEARED');
    await waitForCondition(
      ctx.page,
      async () => (await pictures()) === 0,
      10000,
      'the picture to leave the screen with clear',
    );
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
