/**
 * The diff widget as the user sees it, and a throwaway checkout to show:
 * shared by the diff suites.
 */

const fs = require('fs');
const path = require('path');
const { TMUXY_CLI } = require('./config');
const { typeInTerminal, pressEnter } = require('./keyboard');
const { waitForCondition } = require('./browser');
const { gitRepo } = require('./git-repo');

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
      untracked: [
        ...(widget?.querySelectorAll(
          '[data-diff-names="Not tracked by git"] .diff-untracked-name',
        ) ?? []),
      ].map((n) => n.textContent),
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

module.exports = { shownDiff, checkout, openDiff, waitForDiff };
