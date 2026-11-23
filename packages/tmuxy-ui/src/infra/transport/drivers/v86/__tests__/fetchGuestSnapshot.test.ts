import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGuestSnapshot } from '../v86Guest';

describe('fetchGuestSnapshot', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hands the zstd file to restore_state as it arrived, with no inflate step', async () => {
    const zst = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
    const fetchMock = vi.fn(async () => new Response(zst));
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await fetchGuestSnapshot('/v86-img/tmux-state.bin.zst');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/v86-img/tmux-state.bin.zst');
    expect(new Uint8Array(bytes)).toEqual(zst);
  });

  it('fails when the snapshot is missing instead of restoring an error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );

    await expect(fetchGuestSnapshot('/v86-img/tmux-state.bin.zst')).rejects.toThrow('HTTP 404');
  });
});
