/**
 * Where a `diff` widget's changes come from: `read_diff` on the app's
 * transport, answered straight to the widget (see `AppRuntimeContext`). The
 * checkout is the pane's own option, so only the pane and the scope are sent.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Effect } from 'effect';
import { TmuxTransport } from '../../../infra/transport/TmuxTransport';
import { formatAdapterError } from '../../../infra/transport/AdapterError';
import { useAppRuntime } from '../../../machines/appHooks';
import type { DiffRead, DiffScope } from '../../../domain/diff';
import type { PaneId } from '../../../domain/ids';
import { useKeyedRequest, type KeyedAnswer } from '../preview/useKeyedRequest';

/** How often the changes are read again while the app is on screen. */
export const DIFF_POLL_MS = 3000;

/**
 * The latest read of `paneId`'s changes in `scope`, read again every
 * {@link DIFF_POLL_MS} while the page is visible, and at once on `refresh`.
 * The last read stays on screen while the next is on its way.
 */
export function useDiffRead(
  paneId: PaneId,
  scope: DiffScope,
): KeyedAnswer<DiffRead> & { refresh: () => void } {
  const runtime = useAppRuntime();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) refresh();
    }, DIFF_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  // A read that says what the last one said hands back the last one, so a
  // diff that has not changed is not drawn again every few seconds.
  const last = useRef<{ text: string; read: DiffRead } | null>(null);
  const answer = useKeyedRequest(`${paneId}:${scope}:${tick}`, () =>
    runtime
      .runPromise(
        Effect.flatMap(TmuxTransport, (t) => t.call('read_diff', { paneId, scope })).pipe(
          Effect.mapError((e) => new Error(formatAdapterError(e))),
        ),
      )
      .then((read) => {
        const text = JSON.stringify(read);
        if (last.current?.text === text) return last.current.read;
        last.current = { text, read };
        return read;
      }),
  );
  return { ...answer, refresh };
}
