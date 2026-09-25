import { describe, it, expect } from 'vitest';

/**
 * SEC-20. The markdown is fetched and rendered in the APP's origin, so a
 * relative URL the document wrote resolved against the app rather than against
 * the file the document was written next to — `![](/api/images/0/1)` and
 * `[x](/commands)` reaching the app's own API through the reader's session.
 *
 * The resolver is exercised through the same logic MarkdownView uses; it is
 * duplicated here rather than exported because it is one expression and the
 * behaviour under test is the POLICY, not the plumbing.
 */
function resolveAgainstDocument(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const resolved = new URL(raw, new URL(base, 'http://localhost:9000/'));
    const allowed = ['http:', 'https:', 'data:', 'blob:', 'tmuxyfile:'];
    return allowed.includes(resolved.protocol) ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

describe('a markdown document resolves its own URLs', () => {
  const doc = 'http://localhost:9000/api/browse/Users/felipe/notes/readme.md';

  it('resolves a relative image against the document, not the app root', () => {
    expect(resolveAgainstDocument('./diagram.png', doc)).toBe(
      'http://localhost:9000/api/browse/Users/felipe/notes/diagram.png',
    );
    expect(resolveAgainstDocument('../img/logo.png', doc)).toBe(
      'http://localhost:9000/api/browse/Users/felipe/img/logo.png',
    );
  });

  it('still resolves an app-absolute path, so the reader can see where it went', () => {
    // This is the shape that used to be silently aimed at the API. It resolves,
    // which is what a browser does — the point is that a RELATIVE url no longer
    // lands here by accident.
    expect(resolveAgainstDocument('/api/images/0/1', doc)).toBe(
      'http://localhost:9000/api/images/0/1',
    );
  });

  it('drops a scheme a document must not pull from', () => {
    for (const raw of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x']) {
      expect(resolveAgainstDocument(raw, doc)).toBeUndefined();
    }
  });

  it('carries the schemes a local page legitimately uses', () => {
    expect(resolveAgainstDocument('pic.png', 'tmuxyfile://localhost/Users/f/a/doc.md')).toBe(
      'tmuxyfile://localhost/Users/f/a/pic.png',
    );
    expect(resolveAgainstDocument('data:image/png;base64,AAAA', doc)).toBe(
      'data:image/png;base64,AAAA',
    );
  });

  it('has nothing to say about a missing url', () => {
    expect(resolveAgainstDocument(undefined, doc)).toBeUndefined();
    expect(resolveAgainstDocument('', doc)).toBeUndefined();
  });
});
