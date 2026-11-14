/**
 * The hunk actions of a `diff` widget: stage, unstage, and revert behind a
 * confirm, with an undo of the last revert. The server reads the checkout
 * again and refuses a file changed since it was drawn (`change_hunk`); the
 * token sent is the one of the patch on screen when the action was asked.
 */

import { useCallback, useState } from 'react';
import { Effect } from 'effect';
import { TmuxTransport } from '../../../infra/transport/TmuxTransport';
import { formatAdapterError, type AdapterError } from '../../../infra/transport/AdapterError';
import { useAppRuntime, useAppSend } from '../../../machines/appHooks';
import type { DiffFile, DiffScope, HunkAction } from '../../../domain/diff';
import type { PaneId } from '../../../domain/ids';

/** A hunk as drawn: its file, its place, and the file's token then. */
export interface DrawnHunk {
  path: string;
  hunk: number;
  token: string;
}

export interface HunkControls {
  scope: DiffScope;
  /** The revert waiting for its confirm. */
  confirming: DrawnHunk | null;
  act: (file: DiffFile, hunk: number, action: HunkAction) => void;
  confirm: () => void;
  cancel: () => void;
  /** The last revert, while it can be undone. */
  lastRevert: { id: string; path: string } | null;
  undo: () => void;
}

/** What the server said, as it said it: a refusal already says nothing was done. */
function reason(e: AdapterError): Error {
  const said = e._tag === 'TransportError' && typeof e.cause === 'string' ? e.cause : null;
  return new Error(said ?? formatAdapterError(e));
}

const DONE: Record<HunkAction, string> = {
  stage: 'Staged a hunk of',
  unstage: 'Unstaged a hunk of',
  revert: 'Reverted a hunk of',
};

export function useHunks(paneId: PaneId, scope: DiffScope, refresh: () => void): HunkControls {
  const runtime = useAppRuntime();
  const send = useAppSend();
  const [confirming, setConfirming] = useState<DrawnHunk | null>(null);
  const [lastRevert, setLastRevert] = useState<{ id: string; path: string } | null>(null);
  const notify = useCallback(
    (text: string, ok: boolean) => send({ type: 'NOTIFY', text, ...(ok ? { kind: 'info' } : {}) }),
    [send],
  );

  const run = useCallback(
    (drawn: DrawnHunk, action: HunkAction) => {
      setConfirming(null);
      runtime
        .runPromise(
          Effect.flatMap(TmuxTransport, (t) =>
            t.call('change_hunk', { paneId, scope, action, ...drawn }),
          ).pipe(Effect.mapError(reason)),
        )
        .then(
          (done) => {
            notify(`${DONE[action]} ${drawn.path}`, true);
            setLastRevert(done.revert ? { id: done.revert, path: drawn.path } : null);
          },
          (error: Error) => notify(error.message, false),
        )
        .finally(refresh);
    },
    [runtime, paneId, scope, notify, refresh],
  );

  const act = useCallback(
    (file: DiffFile, hunk: number, action: HunkAction) => {
      const drawn = { path: file.path, hunk, token: file.token };
      if (action === 'revert') setConfirming(drawn);
      else run(drawn, action);
    },
    [run],
  );

  const undo = useCallback(() => {
    if (!lastRevert) return;
    setLastRevert(null);
    runtime
      .runPromise(
        Effect.flatMap(TmuxTransport, (t) =>
          t.call('undo_revert', { paneId, id: lastRevert.id }),
        ).pipe(Effect.mapError(reason)),
      )
      .then(
        () => notify(`Put back ${lastRevert.path} as it was`, true),
        (error: Error) => notify(error.message, false),
      )
      .finally(refresh);
  }, [runtime, paneId, lastRevert, notify, refresh]);

  return {
    scope,
    confirming,
    act,
    confirm: () => confirming && run(confirming, 'revert'),
    cancel: () => setConfirming(null),
    lastRevert,
    undo,
  };
}
