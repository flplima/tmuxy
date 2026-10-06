/**
 * One transport's view of the server state stream: the state the stream
 * stage (`infra/transport/stateFeed.ts`) sequences for the HTTP and Tauri
 * transports, so both treat it the same way.
 *
 * The stream is a full state followed by deltas, each against the previous
 * emission and numbered by `seq`. Every payload is decoded here, at the
 * boundary; a payload that fails its decode is a `ProtocolError`, logged and
 * handled exactly like a dropped delta — the stream is no longer trusted and
 * the transport refetches a full state (`Resync`), never applies a guess.
 */

import { Either } from 'effect';
import type { ServerState } from '../domain/wire';
import type { TransportEvent } from '../infra/transport/events';
import { adoptInitialState, handleStateUpdate, isDeltaSeqGap } from './deltaProtocol';
import { decodeServerStateOrThrow, decodeStateUpdate, logProtocolError } from './wireDecode';

/** What a `state-update` payload means for the transport. */
export type SequenceStep =
  /** The new state, as the event that publishes it; `seq` is the delta's (null for a full state). */
  | Extract<TransportEvent, { _tag: 'State' }>
  /** The stream lost its sequence (a gap or an undecodable payload): refetch a full state. */
  | { readonly _tag: 'Resync' }
  /** Nothing to apply (a delta before any full state). */
  | { readonly _tag: 'Ignore' };

const RESYNC: SequenceStep = { _tag: 'Resync' };
const IGNORE: SequenceStep = { _tag: 'Ignore' };

export class StateSequencer {
  private state: ServerState | null = null;
  /** Last applied delta seq; null right after a full state. */
  private lastDeltaSeq: number | null = null;
  /**
   * The stream has delivered a full state and no sequence gap since, so it is
   * the client's state (see `adoptInitialState`).
   */
  private synced = false;

  /** A raw `state-update` payload arrived. */
  receive(raw: unknown): SequenceStep {
    const decoded = decodeStateUpdate(raw);
    if (Either.isLeft(decoded)) {
      logProtocolError(decoded.left);
      return this.lose();
    }
    const update = decoded.right;
    let seq: number | null = null;
    if (update.type === 'delta') {
      if (isDeltaSeqGap(this.lastDeltaSeq, update.delta)) return this.lose();
      seq = update.delta.seq;
      this.lastDeltaSeq = seq;
    } else {
      // A full state is a fresh sync point.
      this.lastDeltaSeq = null;
      this.synced = true;
    }
    const next = handleStateUpdate(update, this.state);
    if (!next) return IGNORE;
    this.state = next;
    return { _tag: 'State', state: next, seq };
  }

  /**
   * Take a raw `get_initial_state` answer: decoded (throws its
   * `ProtocolError` when it does not match), then adopted or merged per
   * `adoptInitialState`. Returns the client's state.
   */
  adopt(raw: unknown): ServerState {
    const synced = this.synced;
    const state = adoptInitialState(decodeServerStateOrThrow(raw), this.state, synced);
    this.state = state;
    // A synced stream carries on from its own sequence; an adopted answer
    // starts one.
    if (!synced) this.lastDeltaSeq = null;
    return state;
  }

  /** A new connection opened: until its full state lands, an answer is the state to start from. */
  reopen(): void {
    this.synced = false;
  }

  /** Forget everything (disconnect, session switch). */
  reset(): void {
    this.state = null;
    this.lastDeltaSeq = null;
    this.synced = false;
  }

  private lose(): SequenceStep {
    this.lastDeltaSeq = null;
    this.synced = false;
    return RESYNC;
  }
}
