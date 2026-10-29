/**
 * The phone's bottom view and the installable page: a sideways swipe on the
 * tree slides it to the side pane — the pinned terminal the desktop keeps in
 * its right column, sized to the view — the pane riding in beside the tree
 * under the finger as a tab slide shows both tabs, and back; the page links a
 * manifest that installs it on a home screen. The layout itself is
 * tests/12-touch.test.js.
 */

const {
  PHONE,
  usePhoneContext,
  expectOnScreen,
  swipeSideways,
  swipeSidewaysPausing,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const { waitForCondition } = require('./helpers');

describe('Phone width (390px) with a touchscreen: the bottom view and the app', () => {
  const ctx = usePhoneContext(PHONE);

  test('a sideways swipe slides the tree to the side pane under the finger, sized to the view, and back; the page installs as an app', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();
    await waitForPhoneGrid(ctx.page);

    // 1. The tree, then the dock: the pinned terminal in the chrome's small
    //    type, its pane sized to the view it is drawn in.
    const bottom = await boxOf(ctx.page, '[data-testid="phone-bottom"]');
    expectOnScreen(bottom, 'the bottom view');
    expect(await boxOf(ctx.page, '.phone-tree')).not.toBeNull();
    const y = bottom.top + 40;
    // Half way, finger down: the tree has moved left with it and the side
    // pane is drawn at the tree's right edge, the width of the view, while
    // the tree is still the view in front.
    await swipeSidewaysPausing(ctx.page, y, 330, 60, async (pulled, step) => {
      let tree = null;
      await waitForCondition(
        ctx.page,
        async () => {
          const sliding = await ctx.page.evaluate(
            () => document.querySelector('[data-testid="phone-bottom"]')?.dataset.sliding,
          );
          tree = await boxOf(ctx.page, '.phone-tree');
          const moved = tree.left - bottom.left;
          return sliding === 'tracking' && moved <= pulled - step + 2 && moved >= pulled - 2;
        },
        3000,
        () => `the tree to follow the finger ${pulled}px (last: ${JSON.stringify(tree)})`,
      );
      const side = await boxOf(ctx.page, '.phone-dock');
      expect(Math.abs(side.left - tree.right)).toBeLessThanOrEqual(2);
      expect(Math.abs(side.width - bottom.width)).toBeLessThanOrEqual(2);
      expect(side.width - (bottom.right - side.left)).toBeGreaterThan(0);
    });
    let dock = null;
    await waitForCondition(
      ctx.page,
      async () => {
        dock = await ctx.page.evaluate(() => {
          const view = document.querySelector('[data-testid="phone-bottom"]')?.dataset.view;
          const wrapper = document.querySelector('.phone-dock .pane-wrapper');
          const el = document.querySelector('.phone-dock');
          if (!el) return { view };
          const r = el.getBoundingClientRect();
          const cellWidth = parseFloat(getComputedStyle(el).getPropertyValue('--cell-w'));
          const paneId = wrapper?.dataset.paneId;
          const pane = window.app.getSnapshot().context.panes.find((p) => p.tmuxId === paneId);
          return {
            view,
            paneId: paneId ?? null,
            cols: pane?.width ?? null,
            rows: pane?.height ?? null,
            fit: Math.floor((r.width - 8) / cellWidth),
            box: { left: r.left, right: r.right, width: r.width, height: r.height },
            text: el.innerText,
          };
        });
        return dock.view === 'dock' && dock.paneId !== null && dock.cols === dock.fit;
      },
      20000,
      () => `the dock, with its pane sized to the view (last: ${JSON.stringify(dock)})`,
    );
    expectOnScreen(dock.box, 'the dock');
    expect(dock.rows).toBeGreaterThan(5);
    // A shell prompt in it, drawn in a type one can read.
    const promptSize = await ctx.page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('.phone-dock [role="log"]')).fontSize),
    );
    expect(promptSize).toBeGreaterThanOrEqual(11);

    // Keys go to the dock while it is in front: the keyboard target is its pane.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          (id) =>
            document.querySelector('input[data-keyboard-target]')?.dataset.keyboardTarget === id,
          dock.paneId,
        ),
      5000,
      'the keyboard to go to the dock',
    );

    // Back to the tree, and the terminal holds the keyboard again.
    await swipeSideways(ctx.page, y, 60, 330);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () =>
            document.querySelector('[data-testid="phone-bottom"]')?.dataset.view === 'tree' &&
            !!document.querySelector('.phone-tree'),
        ),
      10000,
      'the swipe back to the tree',
    );

    // 2. Installable: the manifest the page links, and the icons it names.
    const install = await ctx.page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
      const res = await fetch(link);
      const manifest = await res.json();
      const icons = await Promise.all(
        manifest.icons.map(async (i) => {
          const r = await fetch(i.src);
          return { status: r.status, type: r.headers.get('content-type') };
        }),
      );
      const apple = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href');
      const appleIcon = await fetch(apple);
      return {
        link,
        status: res.status,
        type: res.headers.get('content-type'),
        display: manifest.display,
        name: manifest.name,
        icons,
        capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
        theme: document.querySelector('meta[name="theme-color"]')?.content,
        appleIcon: appleIcon.status,
      };
    });
    expect(install.link).toBe('/manifest.webmanifest');
    expect(install.status).toBe(200);
    expect(install.type).toContain('application/manifest+json');
    expect(install.display).toBe('standalone');
    expect(install.name).toBe('tmuxy');
    expect(install.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of install.icons) {
      expect(icon.status).toBe(200);
      expect(icon.type).toBe('image/png');
    }
    expect(install.capable).toBe('yes');
    expect(install.theme).toBe('#000000');
    expect(install.appleIcon).toBe(200);
  }, 120000);
});
