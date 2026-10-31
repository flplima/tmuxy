import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from '../sanitizeSvg';

/** The id the block drew the diagram under, as mermaid writes it. */
const ID = 'm1';
const svg = (inner: string) => `<svg id="${ID}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
const clean = (markup: string, net = false) => sanitizeSvg(markup, { id: ID, net });

/** Every element of `root` and below, by lowercased local name. */
const tags = (root: Element | null) =>
  root ? Array.from(root.querySelectorAll('*'), (el) => el.localName.toLowerCase()) : [];

/**
 * Markdown (and so mermaid) renders in the APP's own
 * origin, not in the sandboxed iframe a page gets — so anything that executes
 * here can POST tmux commands exactly as the app does. Mermaid sanitizes its
 * labels; this is the pass a bypass would also have to get past.
 */
describe('sanitizeSvg', () => {
  it('keeps the diagram', () => {
    const out = clean(svg('<g><rect width="10" height="10"/><text>hi</text></g>'));
    expect(out).not.toBeNull();
    expect(out?.querySelector('rect')).not.toBeNull();
    expect(out?.querySelector('text')?.textContent).toBe('hi');
  });

  it('strips inline handlers, whatever their case', () => {
    const out = clean(svg('<rect onload="alert(1)" ONCLICK="alert(2)" onMouseOver="alert(3)"/>'));
    const rect = out?.querySelector('rect');
    expect(rect).not.toBeNull();
    for (const attr of Array.from(rect!.attributes)) {
      expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
    }
  });

  it('strips a script without taking the diagram with it', () => {
    const out = clean(svg('<script>alert(1)</script><rect/>'));
    expect(out?.querySelector('script')).toBeNull();
    expect(out?.querySelector('rect')).not.toBeNull();
  });

  /**
   * Two mechanisms reach the same end, and both are worth pinning: the
   * allowlist drops these, AND the HTML parser treats several of them as
   * breakout elements that terminate SVG foreign content — so they land
   * OUTSIDE the `<svg>`, which `body.querySelector('svg')` never returns.
   * Either way none of them is in what gets adopted.
   */
  it('lets nothing that fetches or runs into the adopted tree', () => {
    for (const tag of [
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object>',
      '<embed src="x"/>',
      '<form action="/commands"></form>',
      '<link rel="stylesheet" href="https://evil.example/x.css"/>',
      '<base href="https://evil.example/"/>',
    ]) {
      const out = clean(svg(`${tag}<rect/>`));
      const name = /<(\w+)/.exec(tag)![1];
      expect(out?.querySelector(name), `${name} reached the tree`).toBeNull();
    }
  });

  /**
   * `<foreignObject>` is how mermaid's default `htmlLabels` renders the text of
   * every node, so removing it removes the diagram's words. It is kept, and the
   * HTML inside it is held to the same two rules as the rest of the tree.
   */
  it('keeps the labels mermaid draws in HTML, with their handlers gone', () => {
    const out = clean(
      svg(
        '<foreignObject><div onclick="alert(1)">tmuxy-wasm</div>' +
          '<script>alert(2)</script></foreignObject>',
      ),
    );
    expect(out?.querySelector('foreignObject')).not.toBeNull();
    expect(out?.textContent).toContain('tmuxy-wasm');
    expect(out?.querySelector('div')?.hasAttribute('onclick')).toBe(false);
    expect(out?.querySelector('script')).toBeNull();
  });

  it('drops a reference it would not follow, and keeps the ones it would', () => {
    const out = clean(
      svg(
        '<a href="javascript:alert(1)"><rect/></a>' +
          '<a id="ok" href="https://example.com"><rect/></a>' +
          '<a id="frag" href="#node-2"><rect/></a>' +
          '<image href="data:image/png;base64,AAAA"/>' +
          '<use id="marker" href="#arrow"/>' +
          '<use id="data" href="data:image/svg+xml;base64,PHN2Zy8+"/>',
      ),
    );
    expect(out?.querySelector('a:not([id])')?.hasAttribute('href')).toBe(false);
    expect(out?.querySelector('#ok')?.getAttribute('href')).toBe('https://example.com');
    // Mermaid's own click targets are same-document fragments.
    expect(out?.querySelector('#frag')?.getAttribute('href')).toBe('#node-2');
    expect(out?.querySelector('image')?.getAttribute('href')).toMatch(/^data:image\/png/);
    // A `<use>` names a shape of this diagram, never a document of its own.
    expect(out?.querySelector('#marker')?.getAttribute('href')).toBe('#arrow');
    expect(out?.querySelector('#data')?.hasAttribute('href')).toBe(false);
  });

  /**
   * A middle click is an `auxclick`, not a `click`: the block's own handler
   * never saw it, and the browser followed the link with whatever the markup
   * asked for — a `ping` beacon, a tab that keeps `window.opener`.
   */
  it('leaves a link only where it goes', () => {
    const out = clean(
      svg(
        '<a href="https://example.com" ping="https://evil.example/beacon" rel="opener" ' +
          'target="_blank" download="x" referrerpolicy="unsafe-url"><rect/></a>',
      ),
    );
    const link = out?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(Array.from(link!.attributes, (a) => a.name)).toEqual(['href']);
  });

  it('drops the animation that would write a javascript: link after the walk', () => {
    const out = clean(
      svg(
        '<a id="x"><set attributeName="href" to="javascript:alert(1)" begin="0s"/><rect/></a>' +
          '<animate attributeName="href" values="javascript:alert(1)"/>' +
          '<animateTransform attributeName="transform"/><animateMotion/>' +
          '<filter><feImage href="https://evil.example/x.png"/></filter>',
      ),
    );
    for (const name of ['set', 'animate', 'animatetransform', 'animatemotion', 'feimage']) {
      expect(tags(out), `${name} survived`).not.toContain(name);
    }
  });

  it('leaves only text formatting inside a label', () => {
    const out = clean(
      svg(
        '<foreignObject><div><span>ok</span><img src="https://evil.example/x.png">' +
          '<video poster="https://evil.example/p.png"></video><input formaction="/commands"></div></foreignObject>',
      ),
    );
    expect(out?.querySelector('span')?.textContent).toBe('ok');
    expect(out?.querySelector('img, video, input')).toBeNull();
  });

  /**
   * The HTML parser builds HTML inside `<desc>` and `<title>` just as it does
   * inside a `<foreignObject>` — they are integration points too — so markup
   * in them came out as a live `<img>` that loaded on adoption, with or
   * without `--net`.
   */
  it('keeps a title and a description as their words alone', () => {
    const out = clean(
      svg(
        '<title>Flow<img src="https://evil.example/t.png"></title>' +
          '<desc>Steps<img src="https://evil.example/d.png" srcset="https://evil.example/s.png 2x">' +
          '<a href="https://example.com" ping="https://evil.example/ping">here</a></desc><rect/>',
      ),
    );
    expect(out?.querySelector('title')?.textContent).toBe('Flow');
    expect(out?.querySelector('desc')?.textContent).toBe('Stepshere');
    expect(tags(out)).not.toContain('img');
    expect(tags(out)).not.toContain('a');
    expect(out?.outerHTML).not.toContain('evil.example');
  });

  /** Out of a label, an element is SVG or it is not kept. */
  it('keeps no element that is not one a diagram is drawn with', () => {
    const out = clean(
      svg(
        '<metadata><x>1</x></metadata><cursor href="https://evil.example/c.png"/>' +
          '<foreignObject><svg><image href="https://evil.example/i.png"/></svg></foreignObject><rect/>',
      ),
    );
    expect(tags(out)).toEqual(['foreignobject', 'rect']);
  });

  it('keeps the style rules of its own diagram, and nothing that fetches or reaches out', () => {
    const out = clean(
      svg(
        '<style>' +
          '#m1 .node rect{fill:#333}#m1{font-family:x}' +
          'body{display:none}#m10 .x{fill:red}' +
          '#m1 .a{background:url(https://evil.example/beacon)}' +
          '#m1 .b{marker-end:url(#arrow)}' +
          "#m1 .c{background:src('https://evil.example/src')}" +
          '#m1 .d{background:image("https://evil.example/image")}' +
          '@import "https://evil.example/x.css";' +
          '</style><rect style="fill:url(https://evil.example/y)"/>' +
          '<circle style="fill:src(&quot;https://evil.example/z&quot;)"/>',
      ),
    );
    const css = out?.querySelector('style')?.textContent ?? '';
    expect(css).toContain('#m1 .node rect{fill:#333}');
    expect(css).toContain('#m1 .b{marker-end:url(#arrow)}');
    expect(css).not.toContain('body');
    expect(css).not.toContain('#m10');
    expect(css).not.toContain('evil.example');
    expect(out?.querySelector('rect')?.hasAttribute('style')).toBe(false);
    expect(out?.querySelector('circle')?.hasAttribute('style')).toBe(false);
  });

  /**
   * The rules a diagram keeps are the ones scoped to the id the block drew it
   * under, not to whatever id the markup claims: `id="root"` would have
   * scoped them to tmuxy's own `#root`, the whole app.
   */
  it('scopes its styles to the id it was drawn under, never one the markup claims', () => {
    const out = clean(
      '<svg id="root" xmlns="http://www.w3.org/2000/svg"><style>' +
        '#root{display:none}#root .pane-wrapper{opacity:0}#m1 .node{fill:#333}' +
        '</style><rect/></svg>',
    );
    expect(out?.getAttribute('id')).toBe(ID);
    const css = out?.querySelector('style')?.textContent ?? '';
    expect(css).not.toContain('#root');
    expect(css).toContain('#m1 .node{fill:#333}');
  });

  it('loads an image from the network only when the preview may', () => {
    const image = svg('<image href="https://example.com/x.png"/>');
    expect(clean(image)?.querySelector('image')?.hasAttribute('href')).toBe(false);
    expect(clean(image, true)?.querySelector('image')?.getAttribute('href')).toBe(
      'https://example.com/x.png',
    );
  });

  it('reaches nested elements, not just the top level', () => {
    const out = clean(svg('<g><g><g><rect onclick="alert(1)"/></g></g></g>'));
    expect(out?.querySelector('rect')?.hasAttribute('onclick')).toBe(false);
  });

  it('says so when the string is not SVG at all', () => {
    expect(clean('<p>not svg</p>')).toBeNull();
    expect(clean('<svg unclosed')).toBeNull();
    expect(clean('')).toBeNull();
  });
});
