import { TmuxOp } from '../../domain/commands';

/** Keystrokes within ~1 frame go out as one send. */
const KEY_BATCH_INTERVAL_MS = 16;

type Kind = 'keys' | 'text';

/** One window's worth of one kind of keystroke, per target. */
class Batch {
  readonly pending = new Map<string, string[]>();
  /** The trailing flush, after one frame; a window is open while it is set. */
  window: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly kind: Kind) {}

  closeWindow(): void {
    if (this.window !== null) clearTimeout(this.window);
    this.window = null;
  }

  hasPending(): boolean {
    for (const parts of this.pending.values()) if (parts.length > 0) return true;
    return false;
  }
}

/**
 * Rate-limits keystroke ops (`SendKeys`, `SendText`) to at most one send per
 * ~frame (16ms) per kind, without delaying isolated keystrokes.
 *
 * Leading edge: a keystroke arriving with no batch window open is sent
 * IMMEDIATELY — a lone keypress never waits out the 16ms window (that wait
 * was the dominant share of the local input→paint floor, see
 * docs/PERFORMANCE.md). The send opens a window; keys arriving inside it
 * accumulate per target and flush together when it closes (trailing edge).
 * A non-empty trailing flush re-opens the window, so sustained fast input
 * (paste, key-repeat) still coalesces to ~one send per frame.
 *
 * The batch is made of ops, so what goes out is one `SendKeys` of the joined
 * key names or one `SendText` of the joined text, quoted by `toTmuxCommand`
 * like any other. Order is kept across the two kinds: a keystroke of one kind
 * flushes what its target has pending of the other first.
 */
export class KeyBatcher {
  private readonly keys = new Batch('keys');
  private readonly text = new Batch('text');

  constructor(private readonly send: (op: TmuxOp) => void) {}

  /**
   * Take a keystroke op into the batch (it is then sent, now or with the
   * window); false for any other op, which the caller sends itself. Key names
   * that start with a flag (`-X cancel`, `-N 3 Up`) are sent alone: joined
   * with others, the flag would apply to keys it was never meant for.
   */
  take(op: TmuxOp): boolean {
    const taken =
      op._tag === 'SendText'
        ? { batch: this.text, other: this.keys, target: op.target, part: op.text }
        : op._tag === 'SendKeys' && !op.keys.startsWith('-')
          ? { batch: this.keys, other: this.text, target: op.target, part: op.keys }
          : null;
    if (!taken) return false;
    const { batch, other, target, part } = taken;
    this.flushTarget(other, target);
    if (batch.window === null) {
      this.send(this.opFor(batch.kind, target, [part]));
      batch.window = this.openWindow(batch);
    } else {
      const parts = batch.pending.get(target) ?? [];
      parts.push(part);
      batch.pending.set(target, parts);
    }
    return true;
  }

  /** Keys taken in and not yet sent: a window is open with something in it. */
  hasPending(): boolean {
    return this.keys.hasPending() || this.text.hasPending();
  }

  /** Send everything pending now and close the windows: before an op that must not overtake it. */
  flushAll(): void {
    for (const batch of [this.keys, this.text]) {
      batch.closeWindow();
      this.flush(batch);
    }
  }

  /** Drop everything pending, unsent, and close the windows. */
  destroy(): void {
    for (const batch of [this.keys, this.text]) {
      batch.closeWindow();
      batch.pending.clear();
    }
  }

  private openWindow(batch: Batch): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      batch.window = null;
      // Under sustained input the window stays open so the stream keeps
      // coalescing; an empty one closes and the next key is leading again.
      if (this.flush(batch)) batch.window = this.openWindow(batch);
    }, KEY_BATCH_INTERVAL_MS);
  }

  /** Send every target's pending parts; whether anything went. */
  private flush(batch: Batch): boolean {
    let sent = false;
    for (const [target, parts] of batch.pending) {
      if (parts.length === 0) continue;
      this.send(this.opFor(batch.kind, target, parts));
      sent = true;
    }
    batch.pending.clear();
    return sent;
  }

  private flushTarget(batch: Batch, target: string): void {
    const parts = batch.pending.get(target);
    if (!parts || parts.length === 0) return;
    this.send(this.opFor(batch.kind, target, parts));
    batch.pending.delete(target);
  }

  private opFor(kind: Kind, target: string, parts: string[]): TmuxOp {
    return kind === 'keys'
      ? TmuxOp.SendKeys({ target, keys: parts.join(' ') })
      : TmuxOp.SendText({ target, text: parts.join('') });
  }
}
