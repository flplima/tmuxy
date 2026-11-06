/**
 * The one lane every tmux op takes to a backend, whatever the driver.
 *
 * Ops and calls leave strictly in issue order, one at a time: each host runs every
 * request as its own task (an axum handler per POST, a Tauri command per
 * IPC call), so two in flight at once can reach tmux reversed — a
 * `split-window -h` that overtook a `select-window -t @B` splits the
 * previous tab, and keystrokes transpose. Keystrokes are batched first
 * (`KeyBatcher`), and anything else that is sent flushes them, so nothing
 * overtakes a key typed before it. Every op is the latency tracker's input
 * mark (Axis-B) and a trace event under its own `action_id`.
 */

import { backendCall, type BackendCall } from '../../domain/backendCalls';
import { toTmuxCommand, type TmuxOp } from '../../domain/commands';
import { latencyTracker } from '../latencyTracker';
import { tracer } from '../tracer';
import { KeyBatcher } from './keyBatching';

/** Move one call to the backend and bring back its raw answer. */
export type SendCall = (call: BackendCall, actionId: string | undefined) => Promise<unknown>;

export interface CommandLane {
  /**
   * Run `op` after every op before it. A keystroke resolves once it is
   * taken (its failure is reported, since nothing awaits it); any other op
   * with the backend's answer.
   */
  run(op: TmuxOp): Promise<void>;
  /** Send `call` after every op and call before it, the batched keystrokes first; its raw answer. */
  call(call: BackendCall): Promise<unknown>;
  /** Ops queued or in flight, and keystrokes batched but unsent. */
  pending(): number;
  /** Drop the batched keystrokes: the connection they were typed into is gone. */
  close(): void;
}

/**
 * The lane over `send`. With `ordered` (the driver keeps its sends in call
 * order itself, `TransportDriver.ordersSends`) each goes at once; otherwise
 * each waits for the one before it to be answered.
 */
export function commandLane(send: SendCall, ordered = false): CommandLane {
  let tail: Promise<unknown> = Promise.resolve();
  let inFlight = 0;

  const queue = (call: BackendCall, actionId?: string): Promise<unknown> => {
    inFlight++;
    const sent = ordered ? send(call, actionId) : tail.then(() => send(call, actionId));
    const done = sent.finally(() => inFlight--);
    // The next send waits for this one to settle, never for it to succeed.
    tail = done.catch(() => undefined);
    return done;
  };

  const enqueue = (op: TmuxOp, kind: 'command' | 'keys'): Promise<void> => {
    latencyTracker.markInput();
    const actionId = tracer.actionId();
    tracer.event({ layer: 'adapter', name: 'send', kind, action_id: actionId });
    const call = backendCall('run_tmux_command', { command: toTmuxCommand(op) });
    return queue(call, actionId).then(() => undefined);
  };

  const keys = new KeyBatcher((op) => {
    enqueue(op, 'keys').catch((cause: unknown) => {
      tracer.event({ layer: 'adapter', name: 'fail', kind: 'keys' });
      // The keys themselves stay out of the log: they can be a password.
      console.error('[transport] keystrokes lost:', cause);
    });
  });

  return {
    run: (op) => {
      if (keys.take(op)) return Promise.resolve();
      keys.flushAll();
      return enqueue(op, 'command');
    },
    call: (call) => {
      keys.flushAll();
      return queue(call);
    },
    pending: () => inFlight + (keys.hasPending() ? 1 : 0),
    close: () => keys.destroy(),
  };
}
