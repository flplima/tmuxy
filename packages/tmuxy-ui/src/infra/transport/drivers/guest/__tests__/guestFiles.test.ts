/**
 * The files a page puts in an in-browser guest (`GuestTmuxAdapterOptions.files`):
 * text as given, a URL fetched, and one that cannot be fetched left out
 * rather than failing the start.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGuestFiles } from '../GuestTmuxAdapter';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('loadGuestFiles', () => {
  it('writes text as given and fetches a URL, leaving out one that cannot be fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        url.pathname === '/cat.gif'
          ? new Response(new Uint8Array([0x47, 0x49, 0x46]))
          : new Response('gone', { status: 404 }),
      ),
    );
    const files = await loadGuestFiles({
      'notes.md': '# Notes',
      'cat.gif': new URL('https://example.test/cat.gif'),
      'gone.png': new URL('https://example.test/gone.png'),
    });
    expect(files.map((f) => f.name)).toEqual(['notes.md', 'cat.gif']);
    expect(text(files[0].bytes)).toBe('# Notes');
    expect([...files[1].bytes]).toEqual([0x47, 0x49, 0x46]);
  });
});
