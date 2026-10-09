import { describe, it, expect } from 'vitest';
import { resolveAgainstDocument } from '../markdownUrls';

/**
 * SEC-20. The markdown is fetched and rendered in the APP's origin, so a URL
 * the document wrote resolved against the app rather than against the file the
 * document was written next to — `![](/api/images/0/1)` and `[x](/commands)`
 * reaching the app's own API through the reader's session.
 */
const app = 'http://localhost:9000/';
const doc = 'http://localhost:9000/api/browse/Users/felipe/notes/readme.md';
const resolve = (raw: string | undefined, base = doc) => resolveAgainstDocument(raw, base, app);

describe('a markdown document resolves its own URLs', () => {
  it('resolves a relative image against the document, not the app root', () => {
    expect(resolve('./diagram.png')).toBe(
      'http://localhost:9000/api/browse/Users/felipe/notes/diagram.png',
    );
    expect(resolve('../img/logo.png')).toBe(
      'http://localhost:9000/api/browse/Users/felipe/img/logo.png',
    );
  });

  it('refuses an app-absolute path that is not a file route', () => {
    // The shape that used to be aimed at the API: the reader's browser would
    // have made these requests with the reader's session.
    for (const raw of ['/api/images/0/1', '/events?session=x', '/commands', '/', '/index.html']) {
      expect(resolve(raw)).toBeUndefined();
    }
    // Written as a full URL to the same origin, it is the same request.
    expect(resolve('http://localhost:9000/api/images/0/1')).toBeUndefined();
  });

  it('keeps the route that serves files, which is how local images arrive', () => {
    expect(resolve('/api/browse/Users/felipe/pic.png')).toBe(
      'http://localhost:9000/api/browse/Users/felipe/pic.png',
    );
  });

  it('drops a scheme a document must not pull from', () => {
    for (const raw of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x']) {
      expect(resolve(raw)).toBeUndefined();
    }
  });

  it('carries the schemes a local page legitimately uses', () => {
    expect(resolve('pic.png', 'tmuxyfile://localhost/Users/f/a/doc.md')).toBe(
      'tmuxyfile://localhost/Users/f/a/pic.png',
    );
    expect(resolve('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(resolve('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('has nothing to say about a missing url', () => {
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve('')).toBeUndefined();
  });
});
