/**
 * The phone's bottom view and the installable page: a sideways swipe on the
 * tree slides it to the side pane — the pinned terminal the desktop keeps in
 * its right column, sized to the view — the pane riding in beside the tree
 * under the finger as a tab slide shows both tabs, and back; a tap on the
 * side pane brings the keyboard up for it, and with the keyboard up the
 * terminal above folds away, the keys staying, and the side pane stays above
 * the keyboard, what is typed in view; the page links a manifest that
 * installs it on a home screen. The layout itself is tests/12-touch.test.js,
 * the menu and the tab bar tests/12-touch-menu.test.js.
 *
 * A headless browser draws no keyboard and never shrinks its visual viewport,
 * so the suite brings up a mock one that does both (helpers/keyboard-mock.js).
 */

const {
  PHONE,
  usePhoneContext,
  expectOnScreen,
  swipeSideways,
  swipeSidewaysPausing,
  boxOf,
  waitForPhoneGrid,
  typeOnVirtualKeyboard,
} = require('./helpers/phone');
const { showKeyboard, hideKeyboard } = require('./helpers/keyboard-mock');
const { waitForCondition } = require('./helpers');

/** The dock with the keyboard: where its typed line and cursor are, against the keyboard. */
const dockOverKeyboard = (page, marker) =>
  page.evaluate((m) => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
    };
    const dock = document.querySelector('.phone-dock');
    const paneId = dock?.querySelector('.pane-wrapper')?.dataset.paneId;
    const pane = window.app.getSnapshot().context.panes.find((p) => p.tmuxId === paneId);
    const lines = [...(dock?.querySelectorAll('.terminal-line') ?? [])];
    return {
      dock: box(dock),
      keyboard: box(document.querySelector('[data-testid="mock-keyboard"]')),
      tabs: box(document.querySelector('.phone-tabs')),
      pty: box(document.querySelector('.phone-pty')),
      keys: box(document.querySelector('.key-row')),
      // The output line, not the command that printed it.
      typed: box(lines.find((l) => l.textContent.trim() === m)),
      cursor: box(dock?.querySelector('.terminal-cursor')),
      rows: pane?.height ?? null,
      lineHeight: dock
        ? parseFloat(getComputedStyle(dock).getPropertyValue('--line-height-terminal'))
        : null,
      inputFocused:
        document.activeElement === document.querySelector('input[data-keyboard-target]'),
      target: document.querySelector('input[data-keyboard-target]')?.dataset.keyboardTarget ?? null,
    };
  }, marker);

describe('Phone width (390px) with a touchscreen: the bottom view and the app', () => {
  const ctx = usePhoneContext(PHONE);

  test('a sideways swipe slides the tree to the side pane under the finger, sized to the view; a tap on it raises the keyboard and it stays above it; and back; the page installs as an app', async () => {
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

    // 2. A tap on the side pane brings the keyboard up for it.
    const tapDock = async () => {
      const b = await boxOf(ctx.page, '.phone-dock');
      await ctx.page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
    };
    let over = null;
    const untilOver = (check, what, marker = '') =>
      waitForCondition(
        ctx.page,
        async () => check((over = await dockOverKeyboard(ctx.page, marker))),
        15000,
        () => `${what} (last: ${JSON.stringify(over)})`,
      );
    await tapDock();
    await untilOver(
      (o) => o.inputFocused && o.target === dock.paneId,
      'the tap to raise the keyboard',
    );

    // With the keyboard up the terminal above folds away, the keys and the tab
    // bar staying, and the side pane stays above the keyboard, sized to what
    // is left: what is typed shows there, in view, the cursor under it.
    await showKeyboard(ctx.page, 320);
    await typeOnVirtualKeyboard(ctx.page, 'echo DOCK_$((6*7))_TYPED');
    await ctx.page.keyboard.press('Enter');
    await untilOver(
      (o) =>
        o.typed !== null &&
        o.cursor !== null &&
        o.rows !== null &&
        o.rows * o.lineHeight <= o.dock.height + 1,
      'the typed line in the side pane, sized to its box',
      'DOCK_42_TYPED',
    );
    expect(over.pty.height).toBe(0);
    expect(over.keys.height).toBeGreaterThan(0);
    expect(over.tabs.height).toBeGreaterThan(0);
    expect(over.tabs.top).toBeGreaterThanOrEqual(over.keys.bottom);
    expect(over.dock.height).toBeGreaterThan(over.lineHeight * 5);
    expect(over.dock.bottom).toBeLessThanOrEqual(over.keyboard.top + 1);
    for (const [what, b] of [
      ['the typed line', over.typed],
      ['the cursor', over.cursor],
    ]) {
      if (!(b.top >= over.dock.top - 1 && b.bottom <= over.keyboard.top + 1)) {
        throw new Error(`${what} is not above the keyboard: ${JSON.stringify(over)}`);
      }
    }

    // A tap on it again puts the keyboard away, and the terminal is back.
    await tapDock();
    await hideKeyboard(ctx.page);
    await untilOver((o) => !o.inputFocused && o.pty.height > 200, 'the keyboard away');

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

    // 3. Installable: the manifest the page links, and the icons it names.
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
      const favicons = await Promise.all(
        [...document.querySelectorAll('link[rel="icon"]')].map(async (l) => {
          const r = await fetch(l.getAttribute('href'));
          return {
            href: l.getAttribute('href'),
            status: r.status,
            type: r.headers.get('content-type'),
          };
        }),
      );
      return {
        link,
        status: res.status,
        type: res.headers.get('content-type'),
        display: manifest.display,
        name: manifest.name,
        icons,
        capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
        theme: document.querySelector('meta[name="theme-color"]')?.content,
        windowBg: `rgb(${getComputedStyle(document.documentElement)
          .getPropertyValue('--window-bg-rgb')
          .trim()})`,
        appleIcon: appleIcon.status,
        favicons,
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
    // The phone's own bars in the theme's window colour, not a fixed black.
    expect(install.theme).toBe(install.windowBg);
    expect(install.appleIcon).toBe(200);
    // The rounded favicon as an ICO beside the SVG, for a browser without SVG ones.
    expect(install.favicons.map((f) => f.href).sort()).toEqual(['/favicon.ico', '/favicon.svg']);
    for (const icon of install.favicons) {
      expect(icon.status).toBe(200);
      expect(icon.type).toMatch(/^image\//);
    }
  }, 120000);
});
