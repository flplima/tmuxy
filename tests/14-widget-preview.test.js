/**
 * `tmuxy open`: a local markdown document or page in a pane, following the
 * file as it changes, through the real CLI, server and frame.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  sidebarShown,
  waitForSettled,
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  waitForCondition,
  waitForTerminalText,
  getPrefixKey,
  waitForPrefixActive,
  waitForPrefixConsumed,
} = require('./helpers');
const { tmuxPanes } = require('./helpers/tmux-read');
const { tmuxExec } = require('./helpers/tmux-socket');
const { activePreview, openPreview, previewFrame } = require('./helpers/preview-widget');

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n\n');

async function pressPrefixed(page, key) {
  const prefix = await getPrefixKey(page);
  await page.keyboard.press(prefix.modifier ? `${prefix.modifier}+${prefix.key}` : prefix.key);
  await waitForPrefixActive(page);
  await page.keyboard.press(key);
  await waitForPrefixConsumed(page);
}

function treeRow(page, paneId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="tree-pane-${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const text = (sel) => el.querySelector(sel)?.textContent ?? null;
    return {
      visible: r.width > 0 && r.height > 0 && r.left >= 0,
      icon: text('.sidebar-tree-icon'),
      name: text('.sidebar-tree-name'),
      title: text('.sidebar-tree-title'),
    };
  }, paneId);
}

async function tabPaneCount(page) {
  return tmuxPanes(await page.evaluate(() => window.app.view().activeTabId)).length;
}

async function splitFromPreview(ctx, previewPaneId) {
  const before = await tabPaneCount(ctx.page);
  await pressPrefixed(ctx.page, '-');
  await waitForCondition(
    ctx.page,
    async () => (await tabPaneCount(ctx.page)) === before + 1,
    10000,
    '`prefix -` over the preview to split its pane',
  );
  await waitForShellPrompt(ctx.page);
  await typeInTerminal(ctx.page, 'exit');
  await pressEnter(ctx.page);
  let shown = null;
  await waitForCondition(
    ctx.page,
    async () => {
      shown = await activePreview(ctx.page);
      return (await tabPaneCount(ctx.page)) === before && shown.paneId === previewPaneId;
    },
    10000,
    () => `the split to close, back on the preview (${JSON.stringify(shown)})`,
  );
}

describeE2E('Scenario: tmuxy open previews a local file', {}, (ctx) => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-preview-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a markdown document: drawn with its diagram and image, followed as it changes, and its read gone with it', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    fs.mkdirSync(path.join(dir, 'img'));
    fs.writeFileSync(path.join(dir, 'img', 'logo.png'), PIXEL);
    const doc = path.join(dir, 'doc.md');
    const write = (title) =>
      fs.writeFileSync(
        doc,
        `---\ntitle: ${title}\ntags: [notes]\n---\n\n# ${title}\n\n` +
          `<details open><summary>Tweaks</summary><kbd>Ctrl</kbd> ` +
          `<input type="text" name="label" value=""> ` +
          `<input type="range" name="radius" min="0" max="24" value="8"> ` +
          `<input type="color" name="accent" value="#112233"></details>\n\n` +
          `<script>window.mdScriptRan = true;</script>\n\n` +
          `![logo](img/logo.png)\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n${lines(80)}\n`,
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
    // The front matter is a block of its own, above the document.
    expect(shown.frontMatter).toBe('title: Doc One\ntags: [notes]');
    expect(shown.frontMatterBox.height).toBeGreaterThan(0);
    expect(shown.strays).toBe(0);

    // Safe HTML tags and interactive inputs render visibly; scripts are stripped.
    const htmlControls = await ctx.page.evaluate(() => {
      const md = document.querySelector('.pane-wrapper .preview-markdown');
      const h = (sel) => md?.querySelector(sel)?.getBoundingClientRect()?.height ?? 0;
      return {
        heights: [
          'details[open] summary',
          'kbd',
          'input[name="label"]',
          'input[name="radius"]',
          'input[name="accent"]',
        ].map(h),
        scriptRan: Boolean(window.mdScriptRan),
      };
    });
    expect(htmlControls.heights.every((h) => h > 0)).toBe(true);
    expect(htmlControls.scriptRan).toBe(false);

    await ctx.page.click('.preview-markdown input[name="label"]');
    await ctx.page.keyboard.type('jk');
    await ctx.page.evaluate(() => {
      const set = (sel, val) => {
        const el = document.querySelector(`.preview-markdown ${sel}`);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('input[name="radius"]', '18');
      set('input[name="accent"]', '#ff5500');
    });
    await ctx.page.keyboard.press('Escape');
    expect((await activePreview(ctx.page)).scrollTop).toBe(0);

    await waitForCondition(
      ctx.page,
      async () => {
        const out = tmuxExec(`capture-pane -p -t '${shown.paneId}'`);
        return (
          out.includes('{"input":"label","type":"text","value":"jk"}') &&
          out.includes('{"input":"radius","type":"range","value":18}') &&
          out.includes('{"input":"accent","type":"color","value":"#ff5500"}')
        );
      },
      10000,
      'preview pane console to print input JSON lines',
    );

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

    await pressPrefixed(ctx.page, '[');
    await waitForSettled(ctx.page);
    const afterCopyKey = await ctx.page.evaluate(
      (paneId) => ({
        copy:
          document.querySelector(
            `[data-pane-id="${paneId}"] :is([data-copy-mode="true"], [data-scroll-mode="true"])`,
          ) !== null,
      }),
      shown.paneId,
    );
    expect(afterCopyKey.copy).toBe(false);
    const stillShown = await activePreview(ctx.page);
    expect(stillShown.heading).toBe('Doc Two');
    expect(stillShown.headingBox.height).toBeGreaterThan(0);
    expect(Math.abs(stillShown.scrollTop - readTo)).toBeLessThanOrEqual(2);

    if (!(await sidebarShown(ctx.page, 'left'))) {
      await pressPrefixed(ctx.page, 's');
    }
    let row = null;
    await waitForCondition(
      ctx.page,
      async () => {
        row = await treeRow(ctx.page, shown.paneId);
        return row?.visible && row.name === 'preview';
      },
      15000,
      () => `the tree row to name the preview (${JSON.stringify(row)})`,
    );
    expect(row).toMatchObject({ icon: '\uf0f6', title: 'doc.md' });

    await splitFromPreview(ctx, shown.paneId);

    await ctx.page.keyboard.press('Control+c');
    await waitForCondition(
      ctx.page,
      async () => !(await activePreview(ctx.page)).widget,
      15000,
      'the preview to close',
    );
    await waitForShellPrompt(ctx.page);
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

  test('a diagram is drawn away from the app: what its labels hold reaches neither the page nor the network', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    const hits = [];
    const beacon = http.createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => beacon.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${beacon.address().port}`;
    try {
      // Every <img> naming the beacon that ever enters the app's document.
      await ctx.page.evaluate((origin) => {
        window.beaconImages = [];
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const found = [node, ...node.querySelectorAll('img')].filter(
                (el) => el.localName === 'img' && (el.getAttribute('src') ?? '').startsWith(origin),
              );
              window.beaconImages.push(...found.map((el) => el.getAttribute('src')));
            }
          }
        }).observe(document, { childList: true, subtree: true });
      }, origin);

      const doc = path.join(dir, 'diagrams.md');
      const fence = (body, lang = 'mermaid') => `\`\`\`${lang}\n${body}\n\`\`\`\n`;
      fs.writeFileSync(
        doc,
        `# Diagrams\n\n${fence(`graph TD\n  A["<img src='${origin}/label.png'> Start"] --> B[End]`)}\n` +
          `${fence(`sequenceDiagram\n  Alice->>Bob: $$x$$ <img src='${origin}/formula.png'> Hello`)}\n` +
          `${fence('gitGraph\n  commit\n  branch feature\n  commit', 'pele')}\n`,
      );
      await openPreview(ctx, doc);

      let diagrams = null;
      await waitForCondition(
        ctx.page,
        async () => {
          diagrams = await ctx.page.evaluate(() =>
            Array.from(
              document.querySelectorAll('.preview-markdown .preview-diagram svg'),
              (svg) => {
                const r = svg.getBoundingClientRect();
                return { width: r.width, height: r.height, text: svg.textContent };
              },
            ),
          );
          return diagrams.length === 3 && diagrams.every((d) => d.width > 0 && d.height > 0);
        },
        30000,
        () => `all three diagrams drawn (${JSON.stringify(diagrams)})`,
      );
      expect(diagrams[0].text).toContain('Start');
      expect(diagrams[1].text).toContain('Hello');
      expect(diagrams[2].text).toContain('feature');
      expect(await ctx.page.evaluate(() => window.beaconImages)).toEqual([]);
      expect(hits).toEqual([]);
    } finally {
      beacon.close();
    }
  }, 120000);

  test('a page: framed offline with only its own files, kept in place as it changes, and Ctrl+C from inside it', async () => {
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
  document.addEventListener('copy', () => { const f = document.activeElement; window.copied = f.tagName === 'INPUT' ? f.value.slice(f.selectionStart, f.selectionEnd) : String(getSelection()); });
</script></head>
<body><h1>${heading}</h1><input value="Field Text"><img id="outside" src="../outside.png"><div style="height: 4000px"></div></body></html>\n`,
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
        // The file changing is what reloads the frame: a sample taken as it
        // navigates has no context to answer from, and is simply not yet it.
        try {
          page2 = await frame.evaluate(() => ({
            heading: document.querySelector('h1')?.textContent,
            scrollY: window.scrollY,
          }));
        } catch {
          return false;
        }
        return page2.heading === 'Second Heading' && page2.scrollY > 0;
      },
      15000,
      () => `the page to follow the file (${JSON.stringify(page2)})`,
    );
    expect(Math.abs(page2.scrollY - readTo)).toBeLessThanOrEqual(2);

    // The keyboard is the page's while the user is in it, and tmux's
    // bindings and Ctrl+C still reach the app from there.
    const clickIntoPage = async () => {
      await ctx.page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + 40);
      await waitForCondition(
        ctx.page,
        () => ctx.page.evaluate(() => document.activeElement?.tagName === 'IFRAME'),
        5000,
        'the page to have the keyboard',
      );
    };
    await clickIntoPage();
    await splitFromPreview(ctx, shown.paneId);
    await clickIntoPage();
    // With text selected, or the cursor in a field, a copy is the page's and
    // the preview stays; Ctrl+Shift+C, the terminal's, copies there too.
    const copyIn = async (select, keys, text) => {
      await previewFrame(ctx.page).evaluate(select);
      await ctx.page.keyboard.press(keys);
      const copied = () => previewFrame(ctx.page).evaluate(() => window.copied);
      await waitForCondition(
        ctx.page,
        async () => (await copied()) === text,
        5000,
        () => `${keys} to copy ${text}`,
      );
      expect((await activePreview(ctx.page)).widget).toBeTruthy();
    };
    await copyIn(
      () => getSelection().selectAllChildren(document.querySelector('h1')),
      'Control+c',
      'Second Heading',
    );
    await copyIn(() => document.querySelector('input').select(), 'Control+Shift+C', 'Field Text');
    await previewFrame(ctx.page).evaluate(
      () => document.activeElement.blur() || getSelection().removeAllRanges(),
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
