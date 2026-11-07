/**
 * A phone held sideways, finger only
 *
 * The landscape half of the phone layout (utils/phoneLayout.ts), flat as a
 * desktop: the tree on the left under the menu's button, the terminal in the
 * middle at the height its 25 rows fit over the keys, the side pane on the
 * right with no header, and the twelve keys in one row along the bottom. The
 * menu's button puts the app menu in the tree's place. With the keyboard up,
 * the terminal is cut short and scrolled so the row being typed on stays in
 * view above it, the type the size it was (hooks/usePhoneViewport.ts). The
 * portrait half is tests/12-touch.test.js.
 *
 * As there, every assertion is about boxes on screen.
 */

const { usePhoneContext, typeOnVirtualKeyboard, expectOnScreen } = require('./helpers/phone');
const { waitForCondition, getTerminalText } = require('./helpers');

const SIDEWAYS = { width: 844, height: 390 };

describe('Phone held sideways (844x390) with a touchscreen', () => {
  const ctx = usePhoneContext(SIDEWAYS);

  test('the tree, the terminal at the height of its 25 rows and the side pane side by side over one row of keys; the menu button swaps the tree for the menu; with the keyboard up the row being typed on stays in view', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();

    const measure = () =>
      ctx.page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        const c = window.app?.getSnapshot()?.context;
        return {
          landscape: c?.phoneLandscape ?? null,
          totalHeight: c?.totalHeight,
          rowHeight: c?.charHeight,
          left: box(document.querySelector('.phone-side-left')),
          tree: box(document.querySelector('.phone-side-left .phone-tree')),
          menuButton: box(document.querySelector('.phone-menu-toggle')),
          menu: box(document.querySelector('.phone-side-left .phone-menu')),
          right: box(document.querySelector('.phone-side-right')),
          dockPane: box(document.querySelector('.phone-side-right .pane-wrapper')),
          dockHeader: !!document.querySelector('.phone-side-right .pane-header'),
          keys: box(document.querySelector('.key-row')),
          keyTops: [...document.querySelectorAll('.key-row-key')].map((k) =>
            Math.round(k.getBoundingClientRect().top),
          ),
          pty: box(document.querySelector('.phone-pty')),
          status: box(document.querySelector('.phone-pty .tmux-status-bar')),
          cursor: box(document.querySelector('.pane-active .terminal-cursor')),
        };
      });

    // 1. Sideways: the tree on the left, the terminal in the middle with all
    //    of its 25 rows on screen, the side pane on the right — started for
    //    the column, drawn with no header — and the keys in one row under
    //    them, the screen's width.
    let layout = null;
    await waitForCondition(
      ctx.page,
      async () => {
        layout = await measure();
        return (
          layout.landscape === true &&
          layout.totalHeight === 24 &&
          layout.status !== null &&
          layout.dockPane !== null
        );
      },
      20000,
      () => `the sideways layout and its side pane (last: ${JSON.stringify(layout)})`,
    );
    expectOnScreen(layout.left, 'the tree column', SIDEWAYS.width);
    expectOnScreen(layout.tree, 'the tree', SIDEWAYS.width);
    expectOnScreen(layout.pty, 'the terminal', SIDEWAYS.width);
    expectOnScreen(layout.right, 'the side pane column', SIDEWAYS.width);
    expect(layout.left.right).toBeLessThanOrEqual(layout.pty.left + 1);
    expect(layout.right.left).toBeGreaterThanOrEqual(layout.pty.right - 1);
    expect(layout.right.right).toBeCloseTo(SIDEWAYS.width, 0);
    expect(layout.dockPane.width).toBeGreaterThan(100);
    expect(layout.dockHeader).toBe(false);
    expect(layout.status.bottom).toBeLessThanOrEqual(layout.keys.top + 1);
    expect(layout.keys.width).toBeCloseTo(SIDEWAYS.width, 0);
    expect(layout.keys.bottom).toBeCloseTo(SIDEWAYS.height, 0);
    expect(layout.keyTops).toHaveLength(12);
    expect(new Set(layout.keyTops).size).toBe(1);
    const rowHeight = layout.rowHeight;

    // The menu's button, over the tree: the app menu in its place, and back.
    expect(layout.menuButton.bottom).toBeLessThanOrEqual(layout.tree.top + 1);
    const tapMenuButton = () =>
      ctx.page.touchscreen.tap(
        layout.menuButton.left + layout.menuButton.width / 2,
        layout.menuButton.top + layout.menuButton.height / 2,
      );
    await tapMenuButton();
    await waitForCondition(
      ctx.page,
      async () => {
        layout = await measure();
        return layout.menu !== null && layout.tree === null;
      },
      5000,
      () => `the menu in the tree's place (last: ${JSON.stringify(layout)})`,
    );
    expectOnScreen(layout.menu, 'the menu', SIDEWAYS.width);
    await tapMenuButton();
    await waitForCondition(
      ctx.page,
      async () => {
        layout = await measure();
        return layout.tree !== null && layout.menu === null;
      },
      5000,
      () => `the tree back (last: ${JSON.stringify(layout)})`,
    );

    // 2. A tap on the terminal — the pane in front — opens the keyboard (as
    //    the key row's ⌨ key does); on this phone it takes 200px of the height.
    await ctx.page.touchscreen.tap(layout.pty.left + 60, layout.pty.top + 60);
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT'),
      5000,
      'a tap on the pane in front to open the keyboard',
    );
    await ctx.page.setViewportSize({ width: SIDEWAYS.width, height: 190 });

    // 3. Output pushes the prompt to the bottom row: that row is still in
    //    view, above the keyboard, and the type did not shrink to make room.
    await typeOnVirtualKeyboard(ctx.page, 'seq 60; echo SIDEWAYS_END');
    await ctx.page.keyboard.press('Enter');
    await waitForCondition(
      ctx.page,
      async () => {
        layout = await measure();
        return (
          layout.cursor !== null &&
          layout.cursor.top >= layout.pty.top - 1 &&
          layout.cursor.bottom <= Math.min(layout.pty.bottom, 190) + 1 &&
          (await getTerminalText(ctx.page)).includes('SIDEWAYS_END')
        );
      },
      20000,
      () => `the cursor's row in view above the keyboard (last: ${JSON.stringify(layout)})`,
    );
    expect(layout.rowHeight).toBe(rowHeight);
    expect(layout.landscape).toBe(true);
    expect(layout.keys.bottom).toBeLessThanOrEqual(190 + 1);
  }, 120000);
});
