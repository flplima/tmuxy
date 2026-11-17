/**
 * The preview widget (`tmuxy open`) as the user sees it: shared by the
 * preview suites.
 */

const { TMUXY_CLI } = require('./config');
const { typeInTerminal, pressEnter } = require('./keyboard');

/** The active pane's preview, as the user sees it: the document or the page's frame. */
function activePreview(page) {
  return page.evaluate(() => {
    const { activePaneId } = window.app.view();
    const pane = document.querySelector(`.pane-wrapper[data-pane-id="${activePaneId}"]`);
    const md = pane?.querySelector('.preview-markdown');
    const h1 = md?.querySelector('h1');
    const svg = md?.querySelector('.preview-diagram svg');
    const img = md?.querySelector('img');
    const frontMatter = md?.querySelector('.preview-front-matter');
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
      frontMatter: frontMatter?.innerText ?? null,
      frontMatterBox: box(frontMatter),
      strays: md ? md.querySelectorAll('hr, h2').length : 0,
      scrollTop: md?.scrollTop ?? 0,
      frame: frame
        ? { box: box(frame), title: frame.title, scrollY: Number(frame.dataset.scrollY ?? 0) }
        : null,
      widget: !!pane?.querySelector('.preview'),
    };
  });
}

/** The page's frame, as Playwright reaches into it; null while there is none. */
function previewFrame(page) {
  return page.frames().find((f) => f.url().includes('/api/preview/')) ?? null;
}

/** `tmuxy open <file>`, typed at the active pane's shell. */
async function openPreview(ctx, file) {
  await typeInTerminal(ctx.page, `clear; ${TMUXY_CLI} open ${file}`);
  await pressEnter(ctx.page);
}

module.exports = { activePreview, openPreview, previewFrame };
