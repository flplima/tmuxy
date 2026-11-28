/**
 * `tmuxy open` in a stacked window: a preview collapsed to its header is still
 * a preview, and expanding it shows the page it already drew.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sidebarShown,
  waitForSettled,
  describeE2E,
  waitForShellPrompt,
  waitForCondition,
  sendPrefixCommand,
  waitForPaneCount,
} = require('./helpers');
const { activePreview, openPreview, pressPrefixed, treeRow } = require('./helpers/preview-widget');

const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n\n');

describeE2E('Scenario: a preview in a pane stack', {}, (ctx) => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-preview-stack-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A stacked window (PANE mode's s) collapses every row but the active one
  // to its header. A preview there is still a preview: one row cannot hold
  // the widget marker, and reading that row as a terminal named the preview
  // `bash` in the tree and unmounted it, so expanding it read the document
  // again from the top.
  test('a preview collapsed in a stack keeps its name and icon in the tree, and comes back where the reader left it', async () => {
    await ctx.setupPage();
    const page = ctx.page;
    await waitForShellPrompt(page);

    await sendPrefixCommand(page, 'p');
    await page.keyboard.press('s');
    await waitForPaneCount(page, 2);
    await waitForShellPrompt(page);

    const doc = path.join(dir, 'stacked.md');
    fs.writeFileSync(doc, `# Stacked\n\n${lines(80)}\n`);
    await openPreview(ctx, doc);
    let shown = null;
    await waitForCondition(
      page,
      async () => (shown = await activePreview(page)).heading === 'Stacked',
      30000,
      () => `the document (${JSON.stringify(shown)})`,
    );
    const previewId = shown.paneId;

    const md = await page.$(`.pane-wrapper[data-pane-id="${previewId}"] .preview-markdown`);
    const box = await md.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await waitForCondition(
      page,
      async () => {
        if ((await activePreview(page)).scrollTop > 200) return true;
        await page.mouse.wheel(0, 200);
        return false;
      },
      15000,
      'the document to scroll',
    );
    const readTo = (await activePreview(page)).scrollTop;
    // The document's element, to tell the same page shown again from one
    // composed afresh.
    await page.evaluate((id) => {
      window.stackedPreview = document.querySelector(
        `.pane-wrapper[data-pane-id="${id}"] .preview-markdown`,
      );
    }, previewId);

    if (!(await sidebarShown(page, 'left'))) {
      await pressPrefixed(page, 's');
    }

    // The shell's header, clicked: its row expands and the preview's
    // collapses to its header.
    const shellId = await page.evaluate(
      (id) =>
        [...document.querySelectorAll('.pane-layout .pane-wrapper[data-pane-id]')]
          .map((el) => el.dataset.paneId)
          .find((paneId) => paneId !== id),
      previewId,
    );
    await page.click(`.pane-wrapper[data-pane-id="${shellId}"] .pane-header`);
    const headerVisible = () =>
      page.evaluate((id) => {
        const item = document.querySelector(`.pane-wrapper[data-pane-id="${id}"]`);
        const header = item?.querySelector('.pane-header')?.getBoundingClientRect();
        return Boolean(header && header.width > 20 && header.height > 8);
      }, previewId);
    let height = null;
    await waitForCondition(
      page,
      async () => {
        height = String(
          await ctx.session.runCommand(`display-message -p -t '${previewId}' '#{pane_height}'`),
        ).trim();
        return height === '1' && (await headerVisible());
      },
      10000,
      () => `the preview's row to collapse to its header (height ${height})`,
    );
    await waitForSettled(page);
    let row = null;
    await waitForCondition(
      page,
      async () => {
        row = await treeRow(page, previewId);
        return row?.visible && row.name === 'preview';
      },
      15000,
      () => `the collapsed preview's tree row to name it (${JSON.stringify(row)})`,
    );
    expect(row).toMatchObject({ icon: '\uf0f6', title: 'stacked.md' });

    // Its header, clicked: the same page, at the same place, nothing read again.
    await page.click(`.pane-wrapper[data-pane-id="${previewId}"] .pane-header`);
    let back = null;
    await waitForCondition(
      page,
      async () => {
        back = await page.evaluate((id) => {
          const md = document.querySelector(
            `.pane-wrapper[data-pane-id="${id}"] .preview-markdown`,
          );
          const r = md?.getBoundingClientRect();
          return {
            active: window.app.view().activePaneId === id,
            same: window.stackedPreview === md,
            height: r?.height ?? 0,
            scrollTop: md?.scrollTop ?? 0,
          };
        }, previewId);
        return back.active && back.height > 100;
      },
      15000,
      () => `the preview to expand again (${JSON.stringify(back)})`,
    );
    expect(back.same).toBe(true);
    expect(Math.abs(back.scrollTop - readTo)).toBeLessThanOrEqual(2);
    expect((await treeRow(page, previewId)).name).toBe('preview');
  }, 120000);
});
