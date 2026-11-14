/**
 * "Revive Agent Session" for the pane menu: offered only when `tmuxy agent
 * revive --check` says the pane can be revived (asked through the
 * `agent-revive --mark` script, read back with a query) (a recorded session, and a
 * dead pane or a shell with no jobs), and running the same revive when
 * chosen, so the menu never does what the CLI refuses.
 */

import { useEffect, useState } from 'react';
import { Effect } from 'effect';
import { reviveCheckQuery } from '../../domain/commandHelpers';
import { TmuxOp } from '../../domain/commands';
import type { PaneId } from '../../domain/ids';
import { TmuxTransport } from '../../infra/transport/TmuxTransport';
import { useAppRuntime } from '../../machines/appHooks';
import { op, type AppMenuSpec } from './specs/actions';

/** The item, from the check's answer: only an `ok` offers it. */
export function reviveItems(paneId: PaneId, answer: string | null): AppMenuSpec {
  if (answer?.trim() !== 'ok') return [];
  return [
    {
      kind: 'item',
      id: 'pane-revive',
      label: 'Revive Agent Session',
      icon: 'restart',
      action: op(TmuxOp.ReviveAgent({ paneId })),
    },
  ];
}

export function useReviveItems(paneId: PaneId): AppMenuSpec {
  const runtime = useAppRuntime();
  const [answer, setAnswer] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const ask = Effect.gen(function* () {
      const transport = yield* TmuxTransport;
      if (!transport.answersQueries()) return null;
      yield* transport.run(TmuxOp.CheckRevive({ paneId }));
      return yield* transport.query(reviveCheckQuery(paneId));
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    void runtime.runPromise(ask).then((said) => {
      if (current) setAnswer(said);
    });
    return () => {
      current = false;
    };
  }, [paneId, runtime]);
  return reviveItems(paneId, answer);
}
