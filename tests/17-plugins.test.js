/**
 * Plugins E2E Tests
 *
 * A plugin linked with `tmuxy plugin install --path` shows its actions in the
 * menus, each one opens the surface its manifest declares, a selection
 * reaches the plugin's command byte for byte in a file (never on a command
 * line), and removing the plugin takes its items away without a reload.
 *
 * The plugin is installed against the suite's own scratch config and state
 * dirs (`tmuxEnv`), the ones its tmux server runs with, so the
 * `tmuxy plugin action` a menu item runs inside tmux finds it. The inventory
 * is a global tmux option on the suite's socket, so every test leaves it as
 * it found it: the plugin removed and both options unset.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  describeE2E,
  openSession,
  waitForCondition,
  waitForTerminalText,
  runCommand,
  clickMenuItem,
  noMenuOpen,
  getCopyModeState,
  tmuxRunAsOperator,
} = require('./helpers');
const { writePluginDir, pluginCli, pluginStateDir, knownActions } = require('./helpers/plugins');
const { tmuxExec } = require('./helpers/tmux-socket');
const { tmuxWindow, tmuxPanes } = require('./helpers/tmux-read');

const PLUGIN = 'e2e-surfaces';
const PWNED = path.join(os.tmpdir(), 'tmuxy-e2e-plugin-pwned');

const MANIFEST = `[plugin]
api = 1
name = "${PLUGIN}"
version = "1.0.0"
description = "Opens one pane per surface"

[[actions]]
id = "split"
title = "E2E Split"
menu = "pane"
surface = "split"
command = ["bin/surface", "split"]

[[actions]]
id = "tab"
title = "E2E Tab"
menu = "pane"
surface = "tab"
command = ["bin/surface", "tab"]

[[actions]]
id = "float"
title = "E2E Float"
menu = "pane"
surface = "float"
size = { width = 50, height = 12 }
command = ["bin/surface", "float"]

[[actions]]
id = "zoomed"
title = "E2E Zoomed"
menu = "pane"
surface = "zoomed"
command = ["bin/surface", "zoomed"]

[[actions]]
id = "popup"
title = "E2E Popup"
menu = "pane"
surface = "popup"
command = ["bin/brief"]

[[actions]]
id = "grab"
title = "E2E Grab Selection"
menu = "selection"
surface = "split"
command = ["bin/grab"]
`;

/** Prints a marker, says which pane it is in, and stays until killed. */
const SURFACE = `#!/bin/sh
printf '%s' "$TMUX_PANE" > "$TMUXY_PLUGIN_STATE_DIR/pane-$1"
echo "PLUGIN-SURFACE-$1"
exec sleep 600
`;

/** Shows a marker for a moment, then exits: a popup closes with it. */
const BRIEF = `#!/bin/sh
echo "PLUGIN-SURFACE-popup"
sleep 2
`;

/** Keeps what the plugin was handed. */
const GRAB = `#!/bin/sh
cp "$TMUXY_SELECTION_FILE" "$TMUXY_PLUGIN_STATE_DIR/selection.out"
printf '%s' "$TMUXY_PLUGIN_CONTEXT_JSON" > "$TMUXY_PLUGIN_STATE_DIR/context.json"
`;

/** The fixture plugin in a scratch dir; returns its path. */
const writePlugin = () => writePluginDir(MANIFEST, { surface: SURFACE, brief: BRIEF, grab: GRAB });

/** The plugin's state dir: its log and what its commands leave there. */
const pluginState = () => pluginStateDir(PLUGIN);

/** The plugin's log, for a failure message: what ran, or why it did not. */
const pluginLog = () => {
  try {
    return pluginCli('log', PLUGIN);
  } catch (e) {
    return `(no log: ${e.message.split('\n')[0]})`;
  }
};

/** The pane a surface's command reported it runs in, once it has. */
async function surfacePane(page, surface) {
  const file = path.join(pluginState(), `pane-${surface}`);
  await waitForCondition(
    page,
    () => fs.existsSync(file),
    15000,
    () => `the ${surface} command to start; the plugin's log says:\n${pluginLog()}`,
  );
  return fs.readFileSync(file, 'utf8').trim();
}

/** The tab the page shows, as tmux has it: its panes, whether it is zoomed, and how many tabs there are. */
async function activeWindow(page) {
  const { id, tabs } = await page.evaluate(() => {
    const v = window.app.view();
    return { id: v.activeTabId, tabs: v.windows.filter((w) => w.kind === 'tab').length };
  });
  if (!/^@\d+$/.test(id ?? '')) return { id, zoomed: false, panes: [], tabs };
  try {
    return { id, zoomed: tmuxWindow(id).zoomed, panes: tmuxPanes(id).map((p) => p.id), tabs };
  } catch (err) {
    // The page follows tmux a round trip later: right after a kill it can
    // still show a window tmux no longer has, which is "not there yet".
    if (/can't find window/.test(String(err.stderr ?? err.message))) {
      return { id, zoomed: false, panes: [], tabs };
    }
    throw err;
  }
}

/** The float on screen holding `text`, and whether it has a header. */
const floatShowing = (page, text) =>
  page.evaluate((needle) => {
    const float = [...document.querySelectorAll('.float-container')].find((el) =>
      (el.textContent || '').includes(needle),
    );
    if (!float) return null;
    const r = float.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) return null;
    return { header: !!float.querySelector('.pane-header'), width: r.width };
  }, text);

describeE2E('Scenario 32: Plugins', {}, (ctx) => {
  let pluginDir = null;

  beforeEach(async () => {
    fs.rmSync(PWNED, { force: true });
    fs.rmSync(pluginState(), { recursive: true, force: true });
    pluginDir = writePlugin();
  }, ctx.hookTimeout);
  afterEach(async () => {
    try {
      pluginCli('remove', PLUGIN, '--purge');
    } catch {
      // Already removed by the test.
    }
    tmuxRunAsOperator('set-option -gu @tmuxy-plugins');
    tmuxRunAsOperator('set-option -gu @tmuxy-plugins-rev');
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }, ctx.hookTimeout);

  test('a linked plugin’s pane actions open in each surface, and its items go when it is removed', async () => {
    const page = ctx.page;
    await openSession(page, ctx.session.name);
    await page.waitForSelector('.pane-layout-item.pane-active', { timeout: 15000 });
    const home = await activeWindow(page);

    // Without a terminal the gate needs --yes; a linked dir has no commit.
    expect(pluginCli('install', '--path', pluginDir, '--yes')).toContain(`linked ${PLUGIN}`);
    await waitForCondition(
      page,
      async () => (await knownActions(page)).includes(`${PLUGIN}:split`),
      10000,
      async () => `the menus to learn of the plugin; they know ${await knownActions(page)}`,
    );

    // split: beside the pane, in the same tab.
    await clickMenuItem(page, ['Pane', 'Plugins', 'E2E Split']);
    const split = await surfacePane(page, 'split');
    await waitForTerminalText(page, 'PLUGIN-SURFACE-split', 15000);
    expect((await activeWindow(page)).panes).toEqual(
      expect.arrayContaining([...home.panes, split]),
    );
    tmuxRunAsOperator(`kill-pane -t ${split}`);
    await waitForCondition(
      page,
      async () => (await activeWindow(page)).panes.length === home.panes.length,
      10000,
      'the split to close',
    );

    // tab: a tab of its own, brought to the front.
    await clickMenuItem(page, ['Pane', 'Plugins', 'E2E Tab']);
    const tabPane = await surfacePane(page, 'tab');
    await waitForCondition(
      page,
      async () => {
        const w = await activeWindow(page);
        return w.id !== home.id && w.panes.includes(tabPane) && w.tabs === home.tabs + 1;
      },
      10000,
      async () =>
        `the plugin's tab to be in front; the page shows ${JSON.stringify(await activeWindow(page))}`,
    );
    await waitForTerminalText(page, 'PLUGIN-SURFACE-tab', 15000);
    tmuxRunAsOperator(`kill-pane -t ${tabPane}`);
    await waitForCondition(
      page,
      async () => (await activeWindow(page)).id === home.id,
      10000,
      'the tab to close',
    );

    // float: over the tab, with its header, at the declared width.
    await clickMenuItem(page, ['Pane', 'Plugins', 'E2E Float']);
    const floatPane = await surfacePane(page, 'float');
    let shown = null;
    await waitForCondition(
      page,
      async () => (shown = await floatShowing(page, 'PLUGIN-SURFACE-float')) !== null,
      15000,
      'the float to be on screen',
    );
    expect(shown.header).toBe(true);
    const floatCols = tmuxExec(`display-message -p -t ${floatPane} '#{@tmuxy-float-width}'`);
    expect(floatCols).toBe('50');
    tmuxRunAsOperator(`kill-pane -t ${floatPane}`);
    await waitForCondition(
      page,
      async () => (await floatShowing(page, 'PLUGIN-SURFACE-float')) === null,
      10000,
      'the float to close',
    );

    // zoomed: a split that fills the tab.
    await clickMenuItem(page, ['Pane', 'Plugins', 'E2E Zoomed']);
    const zoomedPane = await surfacePane(page, 'zoomed');
    await waitForCondition(
      page,
      async () => {
        const w = await activeWindow(page);
        return w.zoomed && w.panes.includes(zoomedPane);
      },
      10000,
      'the tab to be zoomed on the plugin’s pane',
    );
    await waitForTerminalText(page, 'PLUGIN-SURFACE-zoomed', 15000);
    tmuxRunAsOperator(`kill-pane -t ${zoomedPane}`);
    await waitForCondition(
      page,
      async () => !(await activeWindow(page)).zoomed,
      10000,
      'the zoom to end with its pane',
    );

    // popup: no header, and gone when its command exits.
    await clickMenuItem(page, ['Pane', 'Plugins', 'E2E Popup']);
    await waitForCondition(
      page,
      async () => (shown = await floatShowing(page, 'PLUGIN-SURFACE-popup')) !== null,
      15000,
      'the popup to be on screen',
    );
    expect(shown.header).toBe(false);
    await waitForCondition(
      page,
      async () => (await floatShowing(page, 'PLUGIN-SURFACE-popup')) === null,
      15000,
      'the popup to close with its command',
    );

    // Every run is in the plugin's log.
    const log = pluginCli('log', PLUGIN);
    for (const id of ['split', 'tab', 'float', 'zoomed', 'popup']) {
      expect(log).toContain(`open ${PLUGIN}:${id} (menu)`);
    }
    expect(log).toContain(`exit ${PLUGIN}:popup status 0`);

    // Removed: the items go, without a reload.
    pluginCli('remove', PLUGIN);
    await waitForCondition(
      page,
      async () => (await knownActions(page)).length === 0,
      10000,
      'the menus to forget the plugin',
    );
    await clickMenuItem(page, ['Pane']);
    await page
      .locator('[role^="menuitem"]', { hasText: 'Split Pane Below' })
      .waitFor({ state: 'visible', timeout: 5000 });
    expect(await page.locator('[role^="menuitem"]', { hasText: 'Plugins' }).count()).toBe(0);
    // One Escape per level: the Pane submenu, then the app menu.
    for (let level = 0; level < 2; level++) await page.keyboard.press('Escape');
    await waitForCondition(page, () => noMenuOpen(page), 5000, 'the menu to close');
  });

  test('selected text reaches a selection action byte for byte, in a file, and nothing in it runs', async () => {
    const page = ctx.page;
    await openSession(page, ctx.session.name);
    await page.waitForSelector('.pane-layout-item.pane-active', { timeout: 15000 });
    pluginCli('install', '--path', pluginDir, '--yes');
    await waitForCondition(
      page,
      async () => (await knownActions(page)).includes(`${PLUGIN}:grab`),
      10000,
      'the menus to learn of the plugin',
    );

    // History to scroll into: the scroll view only opens over scrollback,
    // and a fresh session's pane has none.
    await runCommand(page, 'seq 1 80', '80');
    // Two lines of text a shell or tmux would read as syntax.
    const first = `it's #1; $(touch ${PWNED})`;
    const second = 'second ; line';
    await runCommand(page, `printf 'it%ss #1; $(touch ${PWNED})\\nsecond ; line\\n' "'"`, second);

    // Into the scroll view, select the two lines as the browser does, and
    // right-click on them.
    await waitForCondition(
      page,
      async () => {
        if ((await getCopyModeState(page))?.mode === 'scroll') return true;
        const pane = await page.$('.pane-layout-item.pane-active');
        const box = await pane.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -120);
        return false;
      },
      10000,
      'the scroll view to open',
    );
    const selected = await page.evaluate(
      ({ a, b }) => {
        const pre = document.querySelector('[data-scroll-mode="true"]');
        const rows = [...pre.children].filter((d) => d.getBoundingClientRect().height > 0);
        const at = rows.findIndex(
          (d, i) => d.textContent.includes(a) && rows[i + 1]?.textContent.includes(b),
        );
        if (at < 0) return null;
        rows[at].scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(rows[at], 0);
        range.setEnd(rows[at + 1], rows[at + 1].childNodes.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 4, y: r.y + r.height / 2 };
      },
      { a: first, b: second },
    );
    expect(selected).not.toBeNull();
    await page.mouse.click(selected.x, selected.y, { button: 'right' });
    const grab = page.locator('[role^="menuitem"]', { hasText: 'E2E Grab Selection' });
    await grab.waitFor({ state: 'visible', timeout: 5000 });
    await grab.click();

    const out = path.join(pluginState(), 'selection.out');
    await waitForCondition(
      page,
      () => fs.existsSync(out),
      15000,
      'the plugin to receive the selection',
    );
    expect(fs.readFileSync(out, 'utf8')).toBe(`${first}\n${second}`);
    expect(fs.existsSync(PWNED)).toBe(false);

    const context = JSON.parse(fs.readFileSync(path.join(pluginState(), 'context.json'), 'utf8'));
    expect(context.trigger).toBe('menu');
    expect(context.action).toBe('grab');
    expect(context.pane.id).toMatch(/^%\d+$/);
    // The file was the command's alone: gone once it exited.
    await waitForCondition(
      page,
      () => !fs.existsSync(context.selection_file),
      10000,
      'the selection file to be removed',
    );
  });
});
