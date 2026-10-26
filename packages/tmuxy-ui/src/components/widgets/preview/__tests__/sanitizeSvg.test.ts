import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from '../sanitizeSvg';

const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

/**
 * SEC-20. Markdown (and so mermaid) renders in the APP's own origin, not in the
 * sandboxed iframe a page gets — so anything that executes here can POST tmux
 * commands exactly as the app does. Mermaid sanitizes its own output; this is
 * the second pass a bypass would also have to get past.
 */
describe('sanitizeSvg', () => {
  it('keeps the diagram', () => {
    const out = sanitizeSvg(svg('<g><rect width="10" height="10"/><text>hi</text></g>'));
    expect(out).not.toBeNull();
    expect(out?.querySelector('rect')).not.toBeNull();
    expect(out?.querySelector('text')?.textContent).toBe('hi');
  });

  it('strips inline handlers, whatever their case', () => {
    const out = sanitizeSvg(
      svg('<rect onload="alert(1)" ONCLICK="alert(2)" onMouseOver="alert(3)"/>'),
    );
    const rect = out?.querySelector('rect');
    expect(rect).not.toBeNull();
    for (const attr of Array.from(rect!.attributes)) {
      expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
    }
  });

  it('strips a script without taking the diagram with it', () => {
    const out = sanitizeSvg(svg('<script>alert(1)</script><rect/>'));
    expect(out?.querySelector('script')).toBeNull();
    expect(out?.querySelector('rect')).not.toBeNull();
  });

  /**
   * Two mechanisms reach the same end, and both are worth pinning: the strip
   * list removes these, AND the HTML parser treats several of them as breakout
   * elements that terminate SVG foreign content — so they land OUTSIDE the
   * `<svg>`, which `body.querySelector('svg')` never returns. Either way none
   * of them is in what gets adopted.
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
      const out = sanitizeSvg(svg(`${tag}<rect/>`));
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
    const out = sanitizeSvg(
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
    const out = sanitizeSvg(
      svg(
        '<a href="javascript:alert(1)"><rect/></a>' +
          '<a id="ok" href="https://example.com"><rect/></a>' +
          '<a id="frag" href="#node-2"><rect/></a>' +
          '<image href="data:image/png;base64,AAAA"/>',
      ),
    );
    expect(out?.querySelector('a:not([id])')?.hasAttribute('href')).toBe(false);
    expect(out?.querySelector('#ok')?.getAttribute('href')).toBe('https://example.com');
    // Mermaid's own click targets are same-document fragments.
    expect(out?.querySelector('#frag')?.getAttribute('href')).toBe('#node-2');
    expect(out?.querySelector('image')?.getAttribute('href')).toMatch(/^data:image\/png/);
  });

  it('drops the animation that would write a javascript: link after the walk', () => {
    const out = sanitizeSvg(
      svg(
        '<a id="x"><set attributeName="href" to="javascript:alert(1)" begin="0s"/><rect/></a>' +
          '<animate attributeName="href" values="javascript:alert(1)"/>' +
          '<animateTransform attributeName="transform"/><animateMotion/>' +
          '<filter><feImage href="https://evil.example/x.png"/></filter>',
      ),
    );
    for (const name of ['set', 'animate', 'animateTransform', 'animateMotion', 'feImage']) {
      const found = Array.from(out!.querySelectorAll('*')).some(
        (el) => el.localName.toLowerCase() === name.toLowerCase(),
      );
      expect(found, `${name} survived`).toBe(false);
    }
  });

  it('leaves only text formatting inside a label', () => {
    const out = sanitizeSvg(
      svg(
        '<foreignObject><div><span>ok</span><img src="https://evil.example/x.png">' +
          '<video poster="https://evil.example/p.png"></video><input formaction="/commands"></div></foreignObject>',
      ),
    );
    expect(out?.querySelector('span')?.textContent).toBe('ok');
    expect(out?.querySelector('img, video, input')).toBeNull();
  });

  it('keeps the style rules of its own diagram, and nothing that fetches or reaches out', () => {
    const out = sanitizeSvg(
      '<svg id="m1" xmlns="http://www.w3.org/2000/svg"><style>' +
        '#m1 .node rect{fill:#333}#m1{font-family:x}' +
        'body{display:none}#m10 .x{fill:red}' +
        '#m1 .a{background:url(https://evil.example/beacon)}' +
        '#m1 .b{marker-end:url(#arrow)}' +
        '@import "https://evil.example/x.css";' +
        '</style><rect style="fill:url(https://evil.example/y)"/></svg>',
    );
    const css = out?.querySelector('style')?.textContent ?? '';
    expect(css).toContain('#m1 .node rect{fill:#333}');
    expect(css).toContain('#m1 .b{marker-end:url(#arrow)}');
    expect(css).not.toContain('body');
    expect(css).not.toContain('#m10');
    expect(css).not.toContain('evil.example');
    expect(out?.querySelector('rect')?.hasAttribute('style')).toBe(false);
  });

  it('loads an image from the network only when the preview may', () => {
    const image = svg('<image href="https://example.com/x.png"/>');
    expect(sanitizeSvg(image)?.querySelector('image')?.hasAttribute('href')).toBe(false);
    expect(sanitizeSvg(image, { net: true })?.querySelector('image')?.getAttribute('href')).toBe(
      'https://example.com/x.png',
    );
  });

  it('reaches nested elements, not just the top level', () => {
    const out = sanitizeSvg(svg('<g><g><g><rect onclick="alert(1)"/></g></g></g>'));
    expect(out?.querySelector('rect')?.hasAttribute('onclick')).toBe(false);
  });

  it('says so when the string is not SVG at all', () => {
    expect(sanitizeSvg('<p>not svg</p>')).toBeNull();
    expect(sanitizeSvg('<svg unclosed')).toBeNull();
    expect(sanitizeSvg('')).toBeNull();
  });
});
