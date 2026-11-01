/**
 * A local page, made ready for its frame.
 *
 * The frame is offline by default (`tmuxy_core::preview::page_csp`): it may
 * load nothing at all, not even the files beside the page. So what the page
 * links locally — stylesheets, scripts, images, fonts, and the `url()`s inside
 * its CSS — is read through `read_preview`, under the server's rules, and
 * written into the page itself as inline code and `data:` URLs. What the page
 * links remotely is left as written, for the policy to allow (`--net`) or
 * refuse.
 *
 * The page is parsed in an inert document (nothing in it runs here), and two
 * things are taken out of it: `<base>`, which would re-aim every relative
 * reference, and `<meta http-equiv>`, which could refresh the frame away or
 * add a policy of its own that refuses the bridge — the policy the page runs
 * under is the one the server serves it with.
 *
 * Then the theme (unless the preview was opened with `--no-theme`) and the
 * bridge go first in `<head>`: the theme as defaults the page's own styles
 * override, the bridge before any of the page's scripts.
 */

import { previewResourcePath, type PreviewResource } from '../../../domain/preview';
import { bridgeScript } from './previewBridge';
import type { PreviewTheme } from './previewTheme';

export type ReadResource = (path: string) => Promise<PreviewResource>;

/** The page's text from a resource's base64 bytes. */
function resourceText(resource: PreviewResource): string {
  const binary = atob(resource.data);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function dataUrl(resource: PreviewResource): string {
  return `data:${resource.mime.split(';')[0]};base64,${resource.data}`;
}

/** Reads each resource once per page, however many times the page links it. */
function memoised(read: ReadResource): (path: string) => Promise<PreviewResource | null> {
  const seen = new Map<string, Promise<PreviewResource | null>>();
  return (path) => {
    let pending = seen.get(path);
    if (!pending) {
      pending = read(path).catch(() => null);
      seen.set(path, pending);
    }
    return pending;
  };
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1\s*;/g;

/** `css` written at `from`, its local `url()`s and `@import`s inlined. */
async function inlineCss(
  css: string,
  from: string,
  read: (path: string) => Promise<PreviewResource | null>,
  depth = 0,
): Promise<string> {
  let out = css;
  if (depth < 3) {
    for (const [statement, , ref] of css.matchAll(CSS_IMPORT)) {
      const path = previewResourcePath(ref, from);
      const resource = path ? await read(path) : null;
      if (path && resource) {
        const imported = await inlineCss(resourceText(resource), path, read, depth + 1);
        // A function, so a `$&` or `$'` in the imported CSS stays itself
        // rather than being read as a replacement pattern.
        out = out.replace(statement, () => imported);
      }
    }
  }
  const urls = [...out.matchAll(CSS_URL)];
  for (const [whole, , ref] of urls) {
    const path = previewResourcePath(ref, from);
    const resource = path ? await read(path) : null;
    if (resource) out = out.replace(whole, () => `url("${dataUrl(resource)}")`);
  }
  return out;
}

/**
 * CSS as the text of a `<style>`, which ends at the first `</style` wherever
 * it appears: an inlined file holding one would close the element and put the
 * rest in the page as markup (a `<base>`, a `<meta http-equiv>`) after those
 * were removed. `\/` is the same `/` to CSS.
 */
function styleText(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

/** Attributes that name a resource the page loads, by element. */
const LOADED_BY: Array<[selector: string, attribute: string]> = [
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['audio[src]', 'src'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['input[type="image"][src]', 'src'],
  ['link[rel~="icon"][href]', 'href'],
  ['image[href]', 'href'],
  ['use[href]', 'href'],
];

function themeCss(raw: PreviewTheme): string {
  // A token is a user's theme file's to set; none may close the <style>.
  const theme = Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, String(value).replace(/[<>]/g, '')]),
  ) as unknown as PreviewTheme;
  return `:root {
  color-scheme: ${theme.mode};
  --tmuxy-foreground: ${theme.foreground};
  --tmuxy-background: ${theme.background};
  --tmuxy-accent: ${theme.accent};
  --tmuxy-muted: ${theme.muted};
  --tmuxy-surface: ${theme.surface};
  --tmuxy-border: ${theme.border};
  --tmuxy-font-mono: ${theme.fontMono};
}
html { background: var(--tmuxy-background); color: var(--tmuxy-foreground); font-family: system-ui, sans-serif; }
a { color: var(--tmuxy-accent); }
code, kbd, pre, samp { font-family: var(--tmuxy-font-mono), monospace; }
pre, code { background: var(--tmuxy-surface); }
hr, table, th, td { border-color: var(--tmuxy-border); }`;
}

/**
 * Escape inline `<script>` body text so neither `</script` nor an HTML comment
 * opener `<!--` (which enters HTML5 script-data escaped/double-escaped state)
 * can desynchronize the parser when the composed document is re-parsed.
 */
function scriptText(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

/**
 * The page at `html` as its frame will load it: local resources inlined, the
 * theme (when one is given) and the bridge, scrolled to `scroll`, added first.
 */
export async function composePage(
  html: string,
  readResource: ReadResource,
  options: { theme: PreviewTheme | null; scroll: { x: number; y: number }; token?: string },
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const read = memoised(readResource);
  // `DOMParser` parses with scripting disabled while `<iframe sandbox="allow-scripts">`
  // parses with scripting enabled, so `<noscript>` markup can hide `<meta http-equiv>`
  // or `<base>` from the inert tree and activate them in the live frame. Scripts are
  // always enabled in the preview frame, so `<noscript>` is removed outright.
  for (const el of Array.from(doc.querySelectorAll('base, meta[http-equiv], noscript'))) {
    el.remove();
  }

  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const path = previewResourcePath(link.getAttribute('href') ?? '');
    const resource = path ? await read(path) : null;
    if (!path || !resource) continue;
    const style = doc.createElement('style');
    const media = link.getAttribute('media');
    if (media) style.setAttribute('media', media);
    style.textContent = styleText(await inlineCss(resourceText(resource), path, read));
    link.replaceWith(style);
  }

  for (const script of Array.from(doc.querySelectorAll('script'))) {
    if (script.hasAttribute('src')) {
      const path = previewResourcePath(script.getAttribute('src') ?? '');
      const resource = path ? await read(path) : null;
      if (!resource) continue;
      script.removeAttribute('src');
      script.textContent = scriptText(resourceText(resource));
    } else if (script.textContent?.includes('<!--')) {
      script.textContent = scriptText(script.textContent);
    }
  }

  for (const [selector, attribute] of LOADED_BY) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      const path = previewResourcePath(el.getAttribute(attribute) ?? '');
      const resource = path ? await read(path) : null;
      if (resource) el.setAttribute(attribute, dataUrl(resource));
    }
  }
  // A local `srcset` candidate would be one more load the frame cannot make;
  // the `src` beside it was inlined above.
  for (const el of Array.from(doc.querySelectorAll('[srcset]'))) {
    const local = (el.getAttribute('srcset') ?? '')
      .split(',')
      .some((candidate) => previewResourcePath(candidate.trim().split(/\s+/)[0] ?? '') !== null);
    if (local) el.removeAttribute('srcset');
  }

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = styleText(await inlineCss(style.textContent ?? '', '', read));
  }
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const style = el.getAttribute('style') ?? '';
    if (style.includes('url(')) el.setAttribute('style', await inlineCss(style, '', read));
  }

  const head = doc.head;
  const bridge = doc.createElement('script');
  bridge.textContent = bridgeScript(options.scroll, options.token);
  head.prepend(bridge);
  if (options.theme) {
    const theme = doc.createElement('style');
    theme.setAttribute('data-tmuxy-theme', '');
    theme.textContent = themeCss(options.theme);
    head.prepend(theme);
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
