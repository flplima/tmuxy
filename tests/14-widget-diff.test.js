/**
 * `tmuxy widget diff`: a git checkout's changes in a pane, in the scope its
 * bar is switched to, through the real CLI, server and git.
 *
 * Which checkout a diff may read is decided by tmux (`@tmuxy-pane-diff`),
 * and what the checkout holds is anyone's text: so besides drawing the
 * right lines, the test checks a line of markup stays text, and that the
 * read is gone with the widget.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TMUXY_CLI,
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  waitForCondition,
  waitForTerminalText,
} = require('./helpers');
const { gitRepo } = require('./helpers/git-repo');
const { tmuxExec } = require('./helpers/tmux-socket');

/** The active pane's diff widget, as the user sees it. */
function shownDiff(page) {
  return page.evaluate(() => {
    const { activePaneId } = window.app.view();
    const pane = document.querySelector(`.pane-wrapper[data-pane-id="${activePaneId}"]`);
    const widget = pane?.querySelector('.diff-widget');
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const lines = [...(widget?.querySelectorAll('[data-diff-line]') ?? [])].map((line) => ({
      kind: line.getAttribute('data-diff-line'),
      text: line.querySelector('.diff-text')?.textContent ?? '',
      box: box(line),
    }));
    return {
      paneId: activePaneId,
      widget: box(widget),
      phone: widget?.classList.contains('is-phone') ?? false,
      scope: widget?.getAttribute('data-diff-scope') ?? null,
      files: [...(widget?.querySelectorAll('[data-diff-file]') ?? [])].map((f) =>
        f.getAttribute('data-diff-file'),
      ),
      lines,
      compared: widget?.querySelector('.diff-compared')?.textContent ?? null,
      untracked: [...(widget?.querySelectorAll('.diff-untracked-name') ?? [])].map(
        (n) => n.textContent,
      ),
      images: widget?.querySelectorAll('img').length ?? 0,
      tabs: [...(widget?.querySelectorAll('[data-diff-scope-tab]') ?? [])].map((tab) => box(tab)),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

/** A checkout on a branch of its own, one commit past `main`. */
function checkout(dir) {
  const { git } = gitRepo(dir);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'one\ntwo\nthree\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'on the branch\n');
  git('add', 'committed.txt');
  git('commit', '-qm', 'branch work');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
  git('add', 'staged.txt');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'one\n<img src=x onerror=alert(1)>\nthree\n');
  fs.writeFileSync(path.join(dir, 'loose.txt'), 'not tracked\n');
  return { git };
}

async function openDiff(page, dir) {
  await typeInTerminal(page, `cd ${dir} && clear && ${TMUXY_CLI} widget diff`);
  await pressEnter(page);
}

async function waitForDiff(page, what, holds) {
  let shown = null;
  await waitForCondition(
    page,
    async () => {
      shown = await shownDiff(page);
      return holds(shown);
    },
    15000,
    () => `${what} (${JSON.stringify(shown)})`,
  );
  return shown;
}

describeE2E('Scenario: tmuxy widget diff shows a checkout’s changes', {}, (ctx) => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-diff-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('each scope shows its changes, follows the checkout as it changes, and its read is gone with it', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);
    checkout(dir);
    await openDiff(ctx.page, dir);

    // 1. Unstaged: the changed line, numbered, as text; the untracked file.
    let shown = await waitForDiff(ctx.page, 'the unstaged changes', (s) =>
      s.files.includes('app.txt'),
    );
    expect(shown.scope).toBe('unstaged');
    expect(shown.files).toEqual(['app.txt']);
    expect(shown.untracked).toEqual(['loose.txt']);
    const markup = shown.lines.find((line) => line.kind === 'added');
    expect(markup.text).toBe('<img src=x onerror=alert(1)>');
    expect(shown.images).toBe(0);
    // On screen, inside the pane, not merely in the DOM.
    expect(shown.widget.width).toBeGreaterThan(200);
    expect(markup.box.height).toBeGreaterThan(5);
    expect(markup.box.y).toBeLessThan(shown.widget.y + shown.widget.height);
    // The pane's read is tmux's to authorise: its option names the checkout.
    const option = tmuxExec(`show-options -p -t ${shown.paneId} -qv @tmuxy-pane-diff`);
    expect(fs.realpathSync(option)).toBe(fs.realpathSync(dir));

    // 2. Staged, then the branch against main.
    await ctx.page.getByRole('tab', { name: 'Staged', exact: true }).click();
    shown = await waitForDiff(
      ctx.page,
      'the staged changes',
      (s) => s.scope === 'staged' && s.files.length === 1 && s.files[0] === 'staged.txt',
    );
    expect(shown.untracked).toEqual([]);
    await ctx.page.getByRole('tab', { name: 'Branch', exact: true }).click();
    shown = await waitForDiff(
      ctx.page,
      'the branch against main',
      (s) => s.compared === 'feature against main',
    );
    expect([...shown.files].sort()).toEqual(['app.txt', 'committed.txt', 'staged.txt']);

    // 3. A change made outside shows without asking.
    fs.writeFileSync(path.join(dir, 'later.txt'), 'later\n');
    await ctx.page.getByRole('tab', { name: 'Unstaged', exact: true }).click();
    await waitForDiff(ctx.page, 'the new untracked file', (s) => s.untracked.includes('later.txt'));
    fs.writeFileSync(path.join(dir, 'app.txt'), 'one\n<img src=x onerror=alert(1)>\nthree\nfour\n');
    await waitForDiff(ctx.page, 'the line added outside', (s) =>
      s.lines.some((line) => line.kind === 'added' && line.text === 'four'),
    );

    // 4. Ctrl+C closes it, and the pane's read goes with it.
    await ctx.page.keyboard.press('Control+c');
    await waitForDiff(ctx.page, 'the diff to close', (s) => s.widget === null);
    await waitForShellPrompt(ctx.page);
    // What authorises the read is the widget's tag, gone with the widget; the
    // checkout's option goes when the script does, once the shell it handed
    // the pane exits, as a preview's file does.
    expect(tmuxExec(`show-options -p -t ${shown.paneId} -qv @tmuxy-pane-widget`)).toBe('');
    const refused = await ctx.page.evaluate(async (paneId) => {
      const session = new URLSearchParams(location.search).get('session') ?? 'tmuxy';
      const response = await fetch(`/commands?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'read_diff', args: { paneId, scope: 'unstaged' } }),
      });
      return { status: response.status, body: await response.json() };
    }, shown.paneId);
    expect(refused.status).toBe(400);
    expect(refused.body.kind).toBe('forbidden');
    await typeInTerminal(ctx.page, 'echo DIFF_CLOSED_$((6*7))');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'DIFF_CLOSED_42', 15000);
  }, 120000);
});

describeE2E(
  'Scenario: tmuxy widget diff on a phone',
  { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  (ctx) => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-diff-phone-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('the phone layout: the scopes fit the screen and take a tap, and a line keeps one number', async () => {
      await ctx.setupPage();
      await waitForShellPrompt(ctx.page);
      checkout(dir);
      // A phone has no keyboard to type with until one is opened: the
      // command goes in as tmux keys, as the person at the screen's would.
      const paneId = await ctx.page.evaluate(() => window.app.view().activePaneId);
      ctx.session.runAsOperator(
        `send-keys -t ${paneId} -l 'cd ${dir} && clear && ${TMUXY_CLI} widget diff'`,
      );
      ctx.session.runAsOperator(`send-keys -t ${paneId} Enter`);
      let shown = await waitForDiff(ctx.page, 'the diff on a phone', (s) =>
        s.files.includes('app.txt'),
      );
      expect(shown.phone).toBe(true);
      for (const tab of shown.tabs) {
        expect(tab.height).toBeGreaterThanOrEqual(36);
        expect(tab.x + tab.width).toBeLessThanOrEqual(shown.viewport.width);
      }
      const numbers = await ctx.page.evaluate(() =>
        [...document.querySelectorAll('[data-diff-line="added"] .diff-no')]
          .filter((no) => no.getBoundingClientRect().width > 0)
          .map((no) => no.textContent),
      );
      expect(numbers).toEqual(['2']);
      await ctx.page.getByRole('tab', { name: 'Branch', exact: true }).tap();
      shown = await waitForDiff(
        ctx.page,
        'the branch scope by a tap',
        (s) => s.scope === 'branch' && s.compared === 'feature against main',
      );
      ctx.session.runAsOperator(`send-keys -t ${paneId} C-c`);
      await waitForDiff(ctx.page, 'the diff to close', (s) => s.widget === null);
    }, 120000);
  },
);
