/**
 * `tmuxy widget browser`: a web page live in a pane, drawn as Kitty graphics
 * from a headless Chrome and driven from the pane, through the real CLI,
 * server and frame. The frame fills the pane's cells, the status line names
 * the page in text, what is typed reaches the page, a click lands on the
 * cell it was made on, and Ctrl+Q hands the pane back to its shell.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTestContext,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  waitForCondition,
  waitForTerminalText,
  getTerminalText,
} = require('./helpers');

const TMUXY_CLI = path.resolve(__dirname, '..', 'packages/tmuxy-cli/bin/tmuxy-cli');

/**
 * A page that reports what reaches it in its title, which the widget's
 * status line prints: the typed line on Enter, the click's coordinates.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>BROWSER_TITLE_OK</title>
<style>html,body{margin:0;height:100%;background:#1e3a5f;color:#fff;font:bold 48px sans-serif}
#box{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}</style></head>
<body><div id="box">LIVE PAGE</div><input id="in" autofocus style="position:absolute;left:0;top:0;opacity:0.01">
<script>
const input = document.getElementById('in');
input.focus();
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { document.title = 'TYPED:' + input.value; input.value = ''; } });
document.body.addEventListener('mousedown', (e) => { e.preventDefault(); document.title = 'CLICKED:' + e.clientX + ',' + e.clientY; input.focus(); });
</script></body></html>`;

/** The pane's live picture, as the user sees it: the first Kitty placement in the active pane. */
function activeFrame(page) {
  return page.evaluate(() => {
    const img = document.querySelector('.pane-active .terminal-image');
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const pane = document.querySelector('.pane-active .terminal-content').getBoundingClientRect();
    return {
      src: img.src,
      protocol: img.dataset.protocol,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      paneLeft: pane.left,
      paneTop: pane.top,
      paneWidth: pane.width,
      paneHeight: pane.height,
    };
  });
}

describe('tmuxy widget browser: a live page in a pane', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-browser-e2e-'));
    fs.writeFileSync(path.join(dir, 'page.html'), PAGE);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('the page fills the pane as Kitty frames, the status line names it, keys and a click reach it, Ctrl+Q ends it', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    await waitForShellPrompt(page);

    // A node that can run it, and a Chrome, where the pane's shell has none
    // of its own (the dev host); CI's runner has both on PATH.
    const env = [
      process.env.TMUXY_NODE ? `TMUXY_NODE=${process.env.TMUXY_NODE}` : '',
      process.env.TMUXY_CHROME ? `TMUXY_CHROME=${process.env.TMUXY_CHROME}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    await typeInTerminal(
      page,
      `${env} ${TMUXY_CLI} widget browser --fps 8 file://${dir}/page.html`.trim(),
    );
    await pressEnter(page);

    // 1. A frame: a Kitty placement whose box is the pane's, less the status row.
    let frame = null;
    await waitForCondition(
      page,
      async () => {
        frame = await activeFrame(page);
        return !!frame && frame.width > 0 && frame.height > 0;
      },
      40000,
      async () =>
        `a frame in the pane (last: ${JSON.stringify(frame)}; the pane says: ${JSON.stringify(
          (await getTerminalText(page)).trim().slice(0, 300),
        )})`,
    );
    expect(frame.protocol).toBe('kitty');
    expect(frame.src).toContain('/api/images/');
    expect(Math.abs(frame.left - frame.paneLeft)).toBeLessThanOrEqual(4);
    expect(Math.abs(frame.top - frame.paneTop)).toBeLessThanOrEqual(4);
    expect(Math.abs(frame.width - frame.paneWidth)).toBeLessThanOrEqual(12);
    expect(frame.height).toBeGreaterThan(frame.paneHeight * 0.8);
    expect(frame.height).toBeLessThan(frame.paneHeight);
    const served = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      return {
        status: resp.status,
        type: resp.headers.get('content-type'),
        size: (await resp.blob()).size,
      };
    }, frame.src);
    expect(served.status).toBe(200);
    expect(served.type).toMatch(/^image\/(jpeg|png)/);
    expect(served.size).toBeGreaterThan(500);

    // 2. The status line, in text: the page's title and its address.
    await waitForTerminalText(page, 'BROWSER_TITLE_OK', 15000);
    expect(await getTerminalText(page)).toContain('page.html');

    // 3. Typing goes to the page: the line and Enter land in its focused
    //    field, and its title says so.
    await typeInTerminal(page, 'hello page');
    await pressEnter(page);
    await waitForTerminalText(page, 'TYPED:hello page', 15000);

    // 4. A click on the picture is a click on the page, at the pixel under
    //    that cell: the UI forwards it as an SGR mouse report while the
    //    program tracks the mouse, and the page reports where it landed.
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          const p = c?.panes?.find((x) => x.tmuxId === c.activePaneId);
          return !!p && p.mouseAnyFlag === true;
        }),
      10000,
      'the client to know the pane tracks the mouse',
    );
    const grid = await page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      const p = c.panes.find((x) => x.tmuxId === c.activePaneId);
      return { cols: p.width, rows: p.height };
    });
    await page.mouse.click(frame.left + frame.width * 0.75, frame.top + frame.height * 0.5);
    await waitForTerminalText(page, 'CLICKED:', 15000);
    const clicked = /CLICKED:(\d+),(\d+)/.exec(await getTerminalText(page));
    expect(clicked).not.toBeNull();
    // Three quarters across and half way down, in the page's own pixels: the
    // page is 8 px a column and 16 px a row, over every row but the status
    // line, so a cell's pixel is known to within a cell.
    const pageWidth = grid.cols * 8;
    const pageHeight = (grid.rows - 1) * 16;
    expect(Math.abs(Number(clicked[1]) - pageWidth * 0.75)).toBeLessThanOrEqual(16);
    expect(Math.abs(Number(clicked[2]) - pageHeight * 0.5)).toBeLessThanOrEqual(32);

    // 5. Ctrl+Q: the picture goes with the alternate screen and the shell is back.
    await page.keyboard.press('Control+q');
    // The program has left the alternate screen and let go of the mouse
    // before the shell is back: a prompt seen earlier is the main screen's
    // old one, restored first.
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          const p = c?.panes?.find((x) => x.tmuxId === c.activePaneId);
          return !!p && p.mouseAnyFlag === false && p.alternateOn === false;
        }),
      10000,
      'the program to hand the terminal back',
    );
    await waitForShellPrompt(page);
    await waitForCondition(
      page,
      async () => (await activeFrame(page)) === null,
      10000,
      'the frame to leave with the program',
    );
    await typeInTerminal(page, 'echo BROWSER_DONE');
    await pressEnter(page);
    await waitForTerminalText(page, 'BROWSER_DONE', 15000, { notOnLineWith: 'echo' });
  }, 120000);
});
