import { describe, expect, it } from 'vitest';
import { parsePreviewLines, previewKind, previewResourcePath } from '../preview';

describe('preview resource paths', () => {
  it('normalises what a document wrote into the path read_preview takes', () => {
    expect(previewResourcePath('img/logo.png')).toBe('img/logo.png');
    expect(previewResourcePath('./css/../img/logo.png?v=2#x')).toBe('img/logo.png');
    expect(previewResourcePath('my%20pic.png')).toBe('my pic.png');
    // Relative to a stylesheet in a subfolder.
    expect(previewResourcePath('../fonts/a.woff2', 'css/site.css')).toBe('fonts/a.woff2');
  });

  it('refuses what a preview never reads', () => {
    for (const ref of [
      'https://example.com/a.png',
      '//cdn.example.com/a.js',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      '#section',
      '/etc/passwd.css',
      '../secret.css',
      'css/../../secret.css',
      '.env.css',
      '.git/hooks/x.js',
      'notes.txt',
      'id_rsa',
      'a\\b.css',
      '%00.css',
      '%E0%A4%A.css',
      '',
    ]) {
      expect(previewResourcePath(ref), ref).toBeNull();
    }
    expect(previewResourcePath('../../x.png', 'css/site.css')).toBeNull();
  });

  it('knows a page from a document from anything else', () => {
    expect(previewKind('/a/Index.HTML')).toBe('html');
    expect(previewKind('notes.markdown')).toBe('markdown');
    expect(previewKind('notes.txt')).toBeNull();
  });
});

describe('preview widget lines', () => {
  it('reads the file, the rev and the theme flag', () => {
    expect(parsePreviewLines(['__FILE__:notes.md', '__REV__:12-34'])).toEqual({
      file: 'notes.md',
      rev: '12-34',
      themed: true,
    });
    expect(parsePreviewLines(['__NO_THEME__', '__FILE__:a.html', '__REV__:1']).themed).toBe(false);
  });

  it('takes the last rev on a line rewritten in place', () => {
    expect(parsePreviewLines(['__REV__:old__REV__:new']).rev).toBe('new');
  });
});
