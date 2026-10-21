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
import type { ServerDelta, ServerState } from '../../domain/wire';
import type { TransportEvent } from './events';
import {
  adoptInitialState,
  applyDelta,
  handleStateUpdate,
  isDeltaSeqGap,
} from '../../domain/deltaProtocol';
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

/** Where a sequenced stream stands (see `StateSequencer.position`). */
export interface StreamPosition {
  readonly seq: number | null;
  readonly diverged: boolean;
}

export class StateSequencer {
  private state: ServerState | null = null;
  /**
   * The seq the next delta must follow: the last applied delta's, or the
   * number of the full state or adopted answer the stream is synced at. Null
   * when the sync point carried no number, so the next delta starts the count.
   */
  private lastDeltaSeq: number | null = null;
  /**
   * The stream has delivered a full state and no sequence gap since, so it is
   * the client's state (see `adoptInitialState`).
   */
  private synced = false;
  /**
   * The stream lost its sequence and no full state or adopted answer has
   * replaced the state since: a delta now would apply to the wrong state.
   */
  private diverged = false;
  /**
   * The deltas that arrived while diverged, in stream order. The stream keeps
   * going while a refetch is out, and the answer it brings is numbered, so the
   * held deltas above that number are applied on top of it: the stream is
   * caught up at once instead of refetching again for every delta the answer
   * raced. A hole among them is a delta lost during the refetch, and is a gap
   * like any other. Bounded, the newest kept: a refetch that hangs under
   * heavy output must not grow the client for as long as it hangs, and an
   * answer older than the oldest held delta costs the one refetch it did
   * before deltas were held at all.
   */
  private held: ServerDelta[] = [];
  private static readonly MAX_HELD = 256;

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
      // Still diverged: hold the delta for the answer, and ask again, since
      // the refetch may have failed.
      if (this.diverged || isDeltaSeqGap(this.lastDeltaSeq, update.delta)) {
        this.held.push(update.delta);
        if (this.held.length > StateSequencer.MAX_HELD) this.held.shift();
        return this.lose();
      }
      seq = update.delta.seq;
      this.lastDeltaSeq = seq;
    } else {
      // A full state is a fresh sync point, numbered when the stream numbers
      // it, so the delta right after it is checked like any other.
      this.lastDeltaSeq = update.state.seq ?? null;
      this.synced = true;
      this.diverged = false;
      this.held = [];
    }
    const next = handleStateUpdate(update, this.state);
    if (!next) return IGNORE;
    this.state = this.stamp(next);
    return { _tag: 'State', state: this.state, seq };
  }

  /**
   * Where the stream stands: the number of the last delta applied (or of the
   * sync point, or null before the stream numbered anything), and whether
   * the sequence was lost. With the store holding the state at that number,
   * the client has nothing of the stream's left to apply — half of what
   * `AppProvider` means by settled.
   */
  position(): StreamPosition {
    return { seq: this.lastDeltaSeq, diverged: this.diverged };
  }

  /**
   * The state carrying the number it is at. A merged state spreads the one
   * before it, so without this a delta's result would still say the sync
   * point's number, and nothing downstream could tell whether it had applied
   * the stream's latest.
   */
  private stamp(state: ServerState): ServerState {
    return this.lastDeltaSeq === null ? state : { ...state, seq: this.lastDeltaSeq };
  }

  /**
   * Take a raw `get_initial_state` answer: decoded (throws its
   * `ProtocolError` when it does not match), then adopted or merged per
   * `adoptInitialState`. Returns the client's state.
   */
  adopt(raw: unknown): ServerState {
    const synced = this.synced;
    const answer = decodeServerStateOrThrow(raw);
    let state = adoptInitialState(answer, this.state, synced);
    this.diverged = false;
    // A synced stream carries on from its own sequence; an adopted answer
    // starts one at the answer's own number, and the deltas the stream
    // delivered above that number while the answer was on its way apply on
    // top of it. A delta lost between the two is a gap, not something
    // applied over.
    if (!synced) {
      this.lastDeltaSeq = answer.seq ?? null;
      state = this.applyHeld(state);
    }
    this.state = this.stamp(state);
    return this.state;
  }

  /**
   * The state as of now, to publish once a refetched answer has been adopted.
   * Deltas that queued up behind the refetch have applied on top of the
   * answer by then, so the answer itself would be older than what was shown.
   * A `Resync` when the deltas held during the refetch had a hole: the
   * answer is adopted, but the stream is not caught up.
   */
  current(): SequenceStep {
    if (this.diverged) return RESYNC;
    return this.state ? { _tag: 'State', state: this.state, seq: null } : IGNORE;
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
    this.diverged = false;
    this.held = [];
  }

  /**
   * Apply the held deltas above the sync point's number, in order, and keep
   * holding from the first hole. An unnumbered sync point cannot place them:
   * the next live delta starts the count, and they are dropped.
   */
  private applyHeld(state: ServerState): ServerState {
    const held = this.held;
    this.held = [];
    if (this.lastDeltaSeq === null) return state;
    for (const [i, delta] of held.entries()) {
      if (delta.seq <= this.lastDeltaSeq) continue;
      if (delta.seq !== this.lastDeltaSeq + 1) {
        this.held = held.slice(i);
        this.lose();
        return state;
      }
      state = applyDelta(state, delta);
      this.lastDeltaSeq = delta.seq;
    }
    return state;
  }

  private lose(): SequenceStep {
    this.lastDeltaSeq = null;
    this.synced = false;
    this.diverged = true;
    return RESYNC;
  }
}
