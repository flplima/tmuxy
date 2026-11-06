/**
 * Plugin keys, link handlers and themes, end to end.
 *
 * A key is bound the moment the plugin is installed (no restart), shows in
 * the menu, never takes a key the user bound, and is gone after `remove`. A
 * Cmd/Ctrl+click on a URL or text a plugin's link handler takes opens its
 * action with the link in the context; Shift, or a URL the server declines,
 * goes to the browser. A plugin theme is offered, applies, and falls back to
 * the default once the plugin is gone.
 *
 * Every test installs the fixture plugin against the suite's own dirs and
 * removes it again, and unsets the global options and the user binding it
 * set, which outlive a run on the suite's tmux server.
 */

const fs = require('fs');
const path = require('path');
const {
  createTestContext,
  navigateToSession,
  waitForCondition,
  runCommand,
  clickMenuItem,
  noMenuOpen,
  sendPrefixCommand,
  shownRunRect,
  tmuxRunAsOperator,
  waitForPaneCount,
  afterFrames,
} = require('./helpers');
const { writePluginDir, pluginCli, pluginStateDir, knownActions } = require('./helpers/plugins');

const PLUGIN = 'e2e-hooks';

const MANIFEST = `[plugin]
api = 1
name = "${PLUGIN}"
version = "1.0.0"

[[actions]]
id = "record"
title = "E2E Record"
menu = "pane"
command = ["bin/record"]

[[link_handlers]]
id = "site"
match = "url"
hosts = ["example.com"]
path_regex = "/allowed/[a-z0-9]+"
action = "record"

[[link_handlers]]
id = "file-line"
match = "text"
pattern = '(?P<path>[\\w./-]+\\.rs):(?P<line>\\d+)'
action = "record"

[[keys]]
key = "M-y"
action = "record"

[[keys]]
key = "M-u"
action = "record"

[[themes]]
id = "night"
file = "themes/night.css"
`;

/** Leaves what it was given, one file per run, and exits (its split closes). */
const RECORD = `#!/bin/sh
n=$(date +%s%N)
printf '%s' "$TMUXY_PLUGIN_CONTEXT_JSON" > "$TMUXY_PLUGIN_STATE_DIR/ctx-$n.json"
printf '%s\\n' "$@" > "$TMUXY_PLUGIN_STATE_DIR/args-$n.txt"
`;

const NIGHT = ':root.theme-dark, :root.theme-light { --term-background: #0a0b0c; }\n';

/** Every run the action recorded, oldest first: its context and arguments. */
function runs() {
  const dir = pluginStateDir(PLUGIN);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('ctx-'))
    .sort()
    .map((f) => ({
      context: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
      args: fs
        .readFileSync(path.join(dir, f.replace('ctx-', 'args-').replace('.json', '.txt')), 'utf8')
        .split('\n')
        .filter(Boolean),
    }));
}

/** What says why an action did not run: its plugin's log, and tmux's M-y. */
function whyNoRun() {
  let log;
  try {
    log = pluginCli('log', PLUGIN).trim() || '(empty)';
  } catch (e) {
    log = `(no log: ${e.message.split('\n')[0]})`;
  }
  const bound = tmuxRunAsOperator('list-keys -T prefix')
    .split('\n')
    .filter((line) => /\sM-y\s/.test(line))
    .join('\n');
  return `the plugin's log says:\n${log}\ntmux binds M-y as: ${bound || '(nothing)'}`;
}

/**
 * The next run after `seen` runs, once the action has recorded it and its
 * split has closed again: until then the pane is mid-resize, and a click
 * computed from its rows can land on the line above.
 */
async function nextRun(page, seen, what) {
  await waitForCondition(
    page,
    () => runs().length > seen,
    15000,
    () => `the action to run from ${what}; ${whyNoRun()}`,
  );
  await waitForPaneCount(page, 1, 10000);
  await afterFrames(page, 2);
  return runs()[seen];
}

/** The page's terminal background, as the theme paints it. */
const termBackground = (page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--term-background').trim(),
  );

/** The client's plugin key bindings, as `key command` lines. */
const pluginBindings = (page) =>
  page.evaluate(() =>
    (window.app.getSnapshot().context.keybindings?.prefix_bindings ?? [])
      .filter((b) => b.command.includes('--trigger key'))
      .map((b) => b.key),
  );

/** Click the run of `text` in the active pane with `modifiers` held. */
async function clickText(page, text, modifiers) {
  const at = await shownRunRect(page, '.pane-layout-item.pane-active', text);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click((at.first + at.last) / 2, at.y);
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
}

describe('Scenario 33: Plugin keys, links and themes', () => {
  const ctx = createTestContext();
  let pluginDir = null;

  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(async () => {
    await ctx.beforeEach();
    fs.rmSync(pluginStateDir(PLUGIN), { recursive: true, force: true });
    pluginDir = writePluginDir(MANIFEST, { record: RECORD }, { 'themes/night.css': NIGHT });
    // A key the user bound: the plugin's M-u must leave it alone.
    tmuxRunAsOperator('bind-key -T prefix M-u display-message user-key');
  }, ctx.hookTimeout);
  afterEach(async () => {
    try {
      pluginCli('remove', PLUGIN, '--purge');
    } catch {
      // Already removed by the test.
    }
    tmuxRunAsOperator('unbind-key -T prefix M-u');
    tmuxRunAsOperator('set-option -gu @tmuxy-plugins');
    tmuxRunAsOperator('set-option -gu @tmuxy-plugins-rev');
    fs.rmSync(pluginDir, { recursive: true, force: true });
    await ctx.afterEach();
  }, ctx.hookTimeout);

  async function installAndOpen() {
    const page = ctx.page;
    await navigateToSession(page, ctx.session.name);
    await page.waitForSelector('.pane-layout-item.pane-active', { timeout: 15000 });
    pluginCli('install', '--path', pluginDir, '--yes');
    await waitForCondition(
      page,
      async () => (await knownActions(page)).includes(`${PLUGIN}:record`),
      10000,
      'the menus to learn of the plugin',
    );
    return page;
  }

  test('a plugin key is bound at once, shown in the menu, keeps the user’s, and goes with the plugin', async () => {
    if (ctx.skipIfNotReady()) return;
    const page = await installAndOpen();

    // Bound with no restart: the reload the install asked for brought it.
    await waitForCondition(
      page,
      async () => (await pluginBindings(page)).includes('M-y'),
      15000,
      async () => `the client to have the plugin key; it has ${await pluginBindings(page)}`,
    );
    expect(await pluginBindings(page)).not.toContain('M-u');
    // The user's M-u is still theirs in tmux, and `list` says why the
    // plugin's is not bound. Read until the install's reloads have settled.
    // The whole table: before tmux 3.8, `list-keys -T prefix M-u` prints nothing.
    const userKey = () =>
      tmuxRunAsOperator('list-keys -T prefix')
        .split('\n')
        .filter((line) => /\sM-u\s/.test(line))
        .join('\n');
    const keptLine = /key\s+prefix M-u -> record\s+NOT BOUND: kept .*display-message user-key/;
    await waitForCondition(
      page,
      () => keptLine.test(pluginCli('list')) && userKey().includes('display-message user-key'),
      10000,
      () => `M-u to stay the user's; tmux has "${userKey()}", list says:\n${pluginCli('list')}`,
    );

    // The menu shows the key beside the action.
    await clickMenuItem(page, ['Pane', 'Plugins']);
    const item = page.locator('[role="menuitem"]', { hasText: 'E2E Record' });
    await item.waitFor({ state: 'visible', timeout: 5000 });
    expect((await item.locator('.menu-keybinding').textContent()).trim()).not.toBe('');
    for (let level = 0; level < 3; level++) await page.keyboard.press('Escape');
    await waitForCondition(page, () => noMenuOpen(page), 5000, 'the menu to close');

    // The key runs the action on the pane it was pressed in.
    const active = await page.evaluate(() => window.app.getSnapshot().context.activePaneId);
    const before = runs().length;
    await sendPrefixCommand(page, 'Alt+y');
    const run = await nextRun(page, before, 'the key');
    expect(run.context.trigger).toBe('key');
    expect(run.context.pane.id).toBe(active);

    // Removed: the binding goes, from tmux and from the client.
    pluginCli('remove', PLUGIN);
    await waitForCondition(
      page,
      async () => !(await pluginBindings(page)).includes('M-y'),
      15000,
      'the plugin key to go',
    );
    expect(tmuxRunAsOperator('list-keys -T prefix')).not.toContain('--trigger key');
  });

  test('a clicked URL or text a link handler takes opens its action; Shift and other URLs go to the browser', async () => {
    if (ctx.skipIfNotReady()) return;
    const page = await installAndOpen();
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (url) => {
        window.__opened.push(url);
        return null;
      };
    });
    const opened = () => page.evaluate(() => window.__opened);
    await runCommand(
      page,
      "printf 'see src/main.rs:42\\nhttps://example.com/allowed/abc1\\nhttps://example.com/other\\n'",
      'example.com/other',
    );

    // Text: the pattern runs on the server; captures and cwd reach the action.
    let seen = runs().length;
    await clickText(page, 'src/main.rs:42', ['Control']);
    const text = await nextRun(page, seen, 'the clicked text');
    expect(text.context.trigger).toBe('link');
    expect(text.context.link.captures).toEqual({ path: 'src/main.rs', line: '42' });
    expect(text.context.pane.cwd).not.toBe('');

    // A URL the handler takes: the URL in the context and as the command's
    // argument, the argv `tmuxy plugin action p:a -- <url>` gives it.
    seen = runs().length;
    await clickText(page, 'https://example.com/allowed/abc1', ['Control']);
    const url = await nextRun(page, seen, 'the clicked URL');
    expect(url.context.link.url).toBe('https://example.com/allowed/abc1');
    expect(url.args).toEqual(['https://example.com/allowed/abc1']);
    expect(await opened()).toEqual([]);

    // Shift goes straight to the browser; so does a URL the server declines.
    seen = runs().length;
    await clickText(page, 'https://example.com/allowed/abc1', ['Control', 'Shift']);
    await clickText(page, 'https://example.com/other', ['Control']);
    await waitForCondition(
      page,
      async () => (await opened()).length === 2,
      10000,
      'both to open in the browser',
    );
    expect(await opened()).toEqual([
      'https://example.com/allowed/abc1',
      'https://example.com/other',
    ]);
    expect(runs().length).toBe(seen);
  });

  test('a plugin theme is offered, applies, and falls back to the default once its plugin goes', async () => {
    if (ctx.skipIfNotReady()) return;
    const page = await installAndOpen();
    const themes = () =>
      page.evaluate(() => window.app.getSnapshot().context.availableThemes.map((t) => t.name));
    await waitForCondition(
      page,
      async () => (await themes()).includes(`${PLUGIN}__night`),
      10000,
      async () => `the theme list to have the plugin's; it has ${await themes()}`,
    );
    const before = await termBackground(page);
    await clickMenuItem(page, ['View', 'Theme', `Night (${PLUGIN})`]);
    await waitForCondition(
      page,
      async () => (await termBackground(page)) === '#0a0b0c',
      10000,
      async () => `the plugin theme to apply; the page shows ${await termBackground(page)}`,
    );

    pluginCli('remove', PLUGIN);
    await waitForCondition(
      page,
      async () => (await termBackground(page)) === before,
      15000,
      async () => `the default theme to come back; the page shows ${await termBackground(page)}`,
    );
    // The colour and the list arrive separately — the session's theme as it
    // changes, the list once the client asks for it again — so the list is
    // waited on too.
    await waitForCondition(
      page,
      async () => !(await themes()).includes(`${PLUGIN}__night`),
      10000,
      async () => `the plugin's theme to leave the list; it has ${await themes()}`,
    );
    // Leave the menu's remembered choice as the suite found it.
    await clickMenuItem(page, ['View', 'Theme', 'Default']);
    tmuxRunAsOperator('set-option -gu @tmuxy-theme');
  });
});
