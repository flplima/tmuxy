/**
 * Rendering & Protocols E2E Tests (Terminal Image Protocols)
 *
 * iTerm2, Kitty and Sixel inline images. Links are in
 * 3-rendering-protocols-links.test.js.
 */

const {
  createTestContext,
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
  function waitForImages(page, minCount = 1, timeout = 15000) {
    return waitForCondition(
      page,
      async () => {
        const images = await getImagePlacements(page);
        return images.length >= minCount ? images : null;
      },
      timeout,
      `at least ${minCount} image placement(s)`,
    );
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
