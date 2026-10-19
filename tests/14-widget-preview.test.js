/**
 * `tmuxy open`: a local markdown document or page in a pane, following the
 * file as it changes, through the real CLI, server and frame.
 *
 * What a preview may read is the file it was opened on and the resources
 * beside it, decided by tmux (`@tmuxy-pane-preview`), and a page runs in a
 * sandboxed frame, offline: so besides drawing the right thing, each test
 * checks what a document could NOT reach.
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
} = require('./helpers');

const TMUXY_CLI = path.resolve(__dirname, '..', 'bin/tmuxy-cli');

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n\n');

/** The active pane's preview, as the user sees it. */
function activePreview(page) {
  return page.evaluate(() => {
    const { activePaneId } = window.app.getSnapshot().context;
    const pane = document.querySelector(`.pane-wrapper[data-pane-id="${activePaneId}"]`);
    const md = pane?.querySelector('.preview-markdown');
    const h1 = md?.querySelector('h1');
    const svg = md?.querySelector('.preview-mermaid svg');
    const img = md?.querySelector('img');
    const frame = pane?.querySelector('iframe.preview-frame');
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { width: r.width, height: r.height } : null;
    };
    return {
      paneId: activePaneId,
      heading: h1?.textContent ?? null,
      headingBox: box(h1),
      diagram: box(svg),
      imageWidth: img?.naturalWidth ?? 0,
      scrollTop: md?.scrollTop ?? 0,
      frame: frame
        ? { box: box(frame), title: frame.title, scrollY: Number(frame.dataset.scrollY ?? 0) }
        : null,
      widget: !!pane?.querySelector('.preview'),
    };
  });
}

/** The frame the preview page runs in, found afresh: each reload is a new URL. */
function previewFrame(page) {
  return page.frames().find((f) => f.url().includes('/api/preview/')) ?? null;
}

async function openPreview(ctx, file) {
  await typeInTerminal(ctx.page, `clear; ${TMUXY_CLI} open ${file}`);
  await pressEnter(ctx.page);
}

describe('Scenario: tmuxy open previews a local file', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-preview-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a markdown document: drawn with its diagram and image, followed as it changes, and its read gone with it', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    fs.mkdirSync(path.join(dir, 'img'));
    fs.writeFileSync(path.join(dir, 'img', 'logo.png'), PIXEL);
    const doc = path.join(dir, 'doc.md');
    const write = (title) =>
      fs.writeFileSync(
        doc,
        `# ${title}\n\n![logo](img/logo.png)\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n${lines(80)}\n`,
      );
    write('Doc One');
    await openPreview(ctx, doc);

    let shown = null;
    await waitForCondition(
      ctx.page,
      async () => {
        shown = await activePreview(ctx.page);
        return shown.heading === 'Doc One' && shown.diagram?.height > 0 && shown.imageWidth > 0;
      },
      30000,
      () => `the document, its diagram and its image (${JSON.stringify(shown)})`,
    );
    expect(shown.headingBox.height).toBeGreaterThan(0);

    // Read down it, then change the file: the preview follows and stays put.
    const md = await ctx.page.$('.pane-wrapper .preview-markdown');
    const box = await md.boundingBox();
    await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await waitForCondition(
      ctx.page,
      async () => {
        if ((await activePreview(ctx.page)).scrollTop > 200) return true;
        await ctx.page.mouse.wheel(0, 200);
        return false;
      },
      15000,
      'the document to scroll',
    );
    const readTo = (await activePreview(ctx.page)).scrollTop;
    write('Doc Two');
    await waitForCondition(
      ctx.page,
      async () => (shown = await activePreview(ctx.page)).heading === 'Doc Two',
      15000,
      'the preview to follow the file',
    );
    expect(Math.abs(shown.scrollTop - readTo)).toBeLessThanOrEqual(2);

    // Ctrl+C is the way out, and the pane's read goes with the preview.
    await ctx.page.keyboard.press('Control+c');
    await waitForCondition(
      ctx.page,
      async () => !(await activePreview(ctx.page)).widget,
      15000,
      'the preview to close',
    );
    await waitForShellPrompt(ctx.page);
    // The shell it hands back still takes Ctrl+C: were it ignored, the sleep
    // would hold the shell and the echo after it would never run.
    await typeInTerminal(ctx.page, 'sleep 600');
    await pressEnter(ctx.page);
    await ctx.page.keyboard.press('Control+c');
    await typeInTerminal(ctx.page, 'echo INTERRUPTED_$((6*7))');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'INTERRUPTED_42', 15000);
    const refused = await ctx.page.evaluate(async (paneId) => {
      const session = new URLSearchParams(location.search).get('session') ?? 'tmuxy';
      const response = await fetch(`/commands?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'read_preview', args: { paneId } }),
      });
      return { status: response.status, body: await response.json() };
    }, shown.paneId);
    expect(refused.status).toBe(400);
    expect(refused.body.kind).toBe('forbidden');
  }, 120000);

  test('a page: framed offline with only its own files, kept in place as it changes, and Ctrl+C from inside it', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    const site = path.join(dir, 'site');
    fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, 'style.css'), 'h1 { letter-spacing: 7px; }\n');
    fs.writeFileSync(path.join(site, '.hidden.css'), 'h1 { color: rgb(255, 0, 0); }\n');
    fs.writeFileSync(path.join(dir, 'outside.png'), PIXEL);
    const page = path.join(site, 'index.html');
    const write = (heading) =>
      fs.writeFileSync(
        page,
        `<!doctype html><html><head><title>Site Page</title>
<link rel="stylesheet" href="style.css"><link rel="stylesheet" href=".hidden.css">
<script>
  window.netResult = 'pending';
  fetch('https://example.com/').then(() => { window.netResult = 'online'; }, () => { window.netResult = 'offline'; });
</script></head>
<body><h1>${heading}</h1><img id="outside" src="../outside.png"><div style="height: 4000px"></div></body></html>\n`,
      );
    write('First Heading');
    await openPreview(ctx, page);

    let shown = null;
    await waitForCondition(
      ctx.page,
      async () => {
        shown = await activePreview(ctx.page);
        return shown.frame?.box?.height > 0 && shown.frame.title === 'Site Page';
      },
      30000,
      () => `the page in its frame, reporting its title (${JSON.stringify(shown)})`,
    );

    const inFrame = () =>
      previewFrame(ctx.page).evaluate(() => {
        const h1 = document.querySelector('h1');
        const style = getComputedStyle(h1);
        return {
          heading: h1.textContent,
          spacing: style.letterSpacing,
          color: style.color,
          background: getComputedStyle(document.documentElement).backgroundColor,
          outsideWidth: document.getElementById('outside').naturalWidth,
          net: window.netResult,
          scrollY: window.scrollY,
        };
      });
    let page1 = null;
    await waitForCondition(
      ctx.page,
      async () => (page1 = await inFrame()).net !== 'pending',
      15000,
      'the page to try the network',
    );
    // Its own stylesheet, inlined; not the hidden one, not the file outside
    // its folder, and no network.
    expect(page1.spacing).toBe('7px');
    expect(page1.color).not.toBe('rgb(255, 0, 0)');
    expect(page1.outsideWidth).toBe(0);
    expect(page1.net).toBe('offline');
    // Drawn in the theme.
    expect(page1.background).not.toBe('rgba(0, 0, 0, 0)');

    // Scroll it, change the file: the new page opens where the reader was.
    const frameBox = await (await ctx.page.$('iframe.preview-frame')).boundingBox();
    await ctx.page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await waitForCondition(
      ctx.page,
      async () => {
        if ((await activePreview(ctx.page)).frame.scrollY > 300) return true;
        await ctx.page.mouse.wheel(0, 300);
        return false;
      },
      15000,
      'the page to scroll',
    );
    const readTo = (await activePreview(ctx.page)).frame.scrollY;
    write('Second Heading');
    let page2 = null;
    await waitForCondition(
      ctx.page,
      async () => {
        const frame = previewFrame(ctx.page);
        if (!frame) return false;
        page2 = await frame.evaluate(() => ({
          heading: document.querySelector('h1')?.textContent,
          scrollY: window.scrollY,
        }));
        return page2.heading === 'Second Heading' && page2.scrollY > 0;
      },
      15000,
      () => `the page to follow the file (${JSON.stringify(page2)})`,
    );
    expect(Math.abs(page2.scrollY - readTo)).toBeLessThanOrEqual(2);

    // The keyboard is the page's while the user is in it, and Ctrl+C still
    // closes the preview.
    await ctx.page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + 40);
    await waitForCondition(
      ctx.page,
      () => ctx.page.evaluate(() => document.activeElement?.tagName === 'IFRAME'),
      5000,
      'the page to have the keyboard',
    );
    await ctx.page.keyboard.press('Control+c');
    await waitForCondition(
      ctx.page,
      async () => !(await activePreview(ctx.page)).widget,
      15000,
      'Ctrl+C in the page to close the preview',
    );
    await waitForShellPrompt(ctx.page);
  }, 120000);
});
