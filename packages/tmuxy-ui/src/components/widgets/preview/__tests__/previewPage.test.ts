import { describe, expect, it } from 'vitest';
import { composePage } from '../previewPage';
import type { PreviewResource } from '../../../../domain/preview';
import type { PreviewTheme } from '../previewTheme';

const THEME: PreviewTheme = {
  mode: 'dark',
  foreground: '#ebdbb2',
  background: '#1d2021',
  accent: '#d79921',
  muted: '#a69682',
  surface: '#282828',
  border: '#3c3836',
  fontMono: 'monospace',
};

const text = (s: string, mime = 'text/plain'): PreviewResource => ({
  mime,
  data: btoa(s),
});

/** A reader over an in-memory folder, recording what it was asked for. */
function folder(files: Record<string, PreviewResource>) {
  const asked: string[] = [];
  const read = async (path: string) => {
    asked.push(path);
    const file = files[path];
    if (!file) throw new Error(`${path}: not found`);
    return file;
  };
  return { read, asked };
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('composing a page for its frame', () => {
  it('inlines the stylesheets, scripts, images and CSS urls beside it', async () => {
    const { read } = folder({
      'css/site.css': text(
        'body { background: url(../img/bg.png) } @import "extra.css";',
        'text/css',
      ),
      'css/extra.css': text('h1 { color: red }', 'text/css'),
      'img/bg.png': { mime: 'image/png', data: 'UE5H' },
      'img/logo.png': { mime: 'image/png', data: 'TE9HTw==' },
      'app.js': text('window.ran = "</script>";', 'text/javascript'),
    });
    const page = parse(
      await composePage(
        `<html><head><link rel="stylesheet" href="css/site.css"><script src="app.js"></script></head>
         <body><img src="./img/logo.png"><div style="background:url('img/bg.png')"></div></body></html>`,
        read,
        { theme: null, scroll: { x: 0, y: 0 } },
      ),
    );
    const css = Array.from(page.querySelectorAll('style'))
      .map((s) => s.textContent)
      .join('\n');
    expect(page.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(css).toContain('url("data:image/png;base64,UE5H")');
    expect(css).toContain('h1 { color: red }');
    const script = Array.from(page.querySelectorAll('script')).find((s) =>
      s.textContent?.includes('window.ran'),
    );
    expect(script?.hasAttribute('src')).toBe(false);
    expect(script?.textContent).toContain('<\\/script>');
    expect(page.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,TE9HTw==');
    expect(page.querySelector('div')?.getAttribute('style')).toContain(
      'data:image/png;base64,UE5H',
    );
  });

  it('never asks for a file outside the folder, a hidden one or a plain file', async () => {
    const { read, asked } = folder({});
    await composePage(
      `<link rel="stylesheet" href="../../.ssh/id_rsa.css"><img src="/etc/passwd.png">
       <script src=".env.js"></script><img src="notes.txt"><link rel="stylesheet" href="https://cdn.example/x.css">`,
      read,
      { theme: null, scroll: { x: 0, y: 0 } },
    );
    expect(asked).toEqual([]);
  });

  it('takes out what would re-aim the page or overrule its policy', async () => {
    const { read } = folder({});
    const page = parse(
      await composePage(
        `<head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">
         <meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head>`,
        read,
        { theme: null, scroll: { x: 0, y: 0 } },
      ),
    );
    expect(page.querySelector('base')).toBeNull();
    expect(page.querySelector('meta[http-equiv]')).toBeNull();
  });

  it('keeps an inlined stylesheet from closing its <style> or rewriting itself', async () => {
    const { read } = folder({
      'evil.css': text(
        'a { color: red } </style><base href="https://evil.example/"><meta http-equiv="refresh" content="0">',
        'text/css',
      ),
      'dollar.css': text('@import "money.css";', 'text/css'),
      'money.css': text(`p::after { content: "$& $' $\`" }`, 'text/css'),
    });
    const page = parse(
      await composePage(
        '<head><link rel="stylesheet" href="evil.css"><link rel="stylesheet" href="dollar.css"></head>',
        read,
        { theme: null, scroll: { x: 0, y: 0 } },
      ),
    );
    expect(page.querySelector('base')).toBeNull();
    expect(page.querySelector('meta[http-equiv]')).toBeNull();
    const css = Array.from(page.querySelectorAll('style'))
      .map((s) => s.textContent)
      .join('\n');
    expect(css).toContain(`content: "$& $' $\``);
  });

  it('puts the theme, then the bridge, before anything of the page', async () => {
    const { read } = folder({});
    const page = parse(
      await composePage(`<head><style>h1{}</style><script>page()</script></head>`, read, {
        theme: THEME,
        scroll: { x: 0, y: 200 },
      }),
    );
    const first = page.head.children;
    expect(first[0].matches('style[data-tmuxy-theme]')).toBe(true);
    expect(first[0].textContent).toContain('color-scheme: dark');
    expect(first[0].textContent).toContain('--tmuxy-background: #1d2021');
    expect(first[1].tagName).toBe('SCRIPT');
    expect(first[1].textContent).toContain('{"x":0,"y":200}');
  });

  it('draws the page in its own colours when opened with --no-theme', async () => {
    const { read } = folder({});
    const page = parse(
      await composePage('<p>x</p>', read, { theme: null, scroll: { x: 0, y: 0 } }),
    );
    expect(page.querySelector('style[data-tmuxy-theme]')).toBeNull();
  });

  it('keeps a token from closing the theme style', async () => {
    const { read } = folder({});
    const html = await composePage('<p>x</p>', read, {
      theme: { ...THEME, accent: 'red</style><script>evil()</script>' },
      scroll: { x: 0, y: 0 },
    });
    expect(html).not.toContain('<script>evil()');
  });
});
