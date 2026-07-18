import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { TmuxyMarkdown } from '../TmuxyMarkdown';
import type { WidgetProps } from '../index';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { resolve, promise };
}

function fakeResponse(body: string) {
  return { ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(body) };
}

const linesForSeq = (seq: string): string[] => ['__FILE__:/doc.md', `__SEQ__:${seq}`];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TmuxyMarkdown out-of-order fetch race', () => {
  it('drops a stale response so a newer __SEQ__ is not clobbered by a late earlier fetch', async () => {
    const first = deferred<ReturnType<typeof fakeResponse>>();
    const second = deferred<ReturnType<typeof fakeResponse>>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise) // __SEQ__:1
      .mockReturnValueOnce(second.promise); // __SEQ__:2
    vi.stubGlobal('fetch', fetchMock);

    const props: WidgetProps = { lines: linesForSeq('1') } as WidgetProps;
    const { rerender } = render(<TmuxyMarkdown {...props} />);
    // Bump the sequence before the first fetch resolves — a second fetch starts.
    rerender(<TmuxyMarkdown {...({ lines: linesForSeq('2') } as WidgetProps)} />);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The newer fetch resolves first and its content renders.
    second.resolve(fakeResponse('# NEWER'));
    await waitFor(() => expect(screen.getByText('NEWER')).toBeTruthy());

    // The stale earlier fetch resolves late — it must not overwrite NEWER.
    first.resolve(fakeResponse('# OLDER'));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText('OLDER')).toBeNull();
    expect(screen.getByText('NEWER')).toBeTruthy();
  });
});
