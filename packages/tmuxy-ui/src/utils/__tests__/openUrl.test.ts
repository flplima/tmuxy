import { describe, it, expect } from 'vitest';
import { isOpenableUrl, safeHref } from '../openUrl';

/**
 * SEC-04 / SEC-21. A pane prints the URL, so the anchor's own `href` is a
 * scheme an attacker picks. Only the left-click path went through
 * `openExternalUrl`; middle-click, Ctrl/Cmd-click, "Open in new tab", "Copy
 * link" and dragging to the address bar all use the attribute directly.
 */
describe('safeHref', () => {
  it('carries the schemes a link is allowed to open', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });

  it('carries no href for a scheme a pane must not hand the browser', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///Users/felipe/.ssh/id_ed25519',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/abc',
      'vscode://file/etc/passwd',
      'tmuxyfile://localhost/etc/passwd',
      '  javascript:alert(1)',
    ]) {
      expect(safeHref(url)).toBeUndefined();
    }
  });

  it('agrees with what openExternalUrl will act on', () => {
    for (const url of ['https://example.com', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(safeHref(url) !== undefined).toBe(isOpenableUrl(url));
    }
  });
});
