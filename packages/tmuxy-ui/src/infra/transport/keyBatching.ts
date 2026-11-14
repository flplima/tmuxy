import { TmuxOp } from '../../domain/commands';
import { isMouseMotion, type MouseReport } from '../../domain/commandHelpers';

const KEY_BATCH_INTERVAL_MS = 16;

type Kind = 'keys' | 'text' | 'mouse';
type Part = string | MouseReport;

/** One window's worth of one kind of input, per target. */
class Batch<P extends Part = Part> {
  readonly pending = new Map<string, P[]>();
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

const sameReport = (a: MouseReport, b: MouseReport): boolean =>
  a.button === b.button && a.x === b.x && a.y === b.y && a.release === b.release;

/**
 * Rate-limits input ops (`SendKeys`, `SendText`, `SendMouse`) to at most one
 * send per ~frame (16ms) per kind, without delaying an isolated one.
 *
 * Leading edge: an input arriving with no batch window open is sent
 * IMMEDIATELY — a lone keypress never waits out the 16ms window (that wait
 * was the dominant share of the local input→paint floor, see
 * docs/PERFORMANCE.md). The send opens a window; input arriving inside it
 * accumulates per target and flushes together when it closes (trailing edge).
 * A non-empty trailing flush re-opens the window, so sustained fast input
 * (paste, key-repeat, a drag, a wheel flick) still coalesces to ~one send per
 * frame.
 *
 * The batch is made of ops, so what goes out is one `SendKeys` of the joined
 * key names, one `SendText` of the joined text or one `SendMouse` of the
 * reports in order, quoted by `toTmuxCommand` like any other. Order is kept
 * across the kinds: an input of one kind flushes what its target has pending
 * of the others first.
 *
 * A pointer on the move reports where it is, not where it was: of a run of
 * motion reports waiting in a window only the last goes, and one that repeats
 * the report before it (the pointer moved inside its cell) is never sent.
 */
export class KeyBatcher {
  private readonly keys = new Batch<string>('keys');
  private readonly text = new Batch<string>('text');
  private readonly mouse = new Batch<MouseReport>('mouse');
  private readonly batches: ReadonlyArray<Batch> = [this.keys, this.text, this.mouse];
  /** The last mouse report taken for each target, sent or waiting. */
  private readonly lastReport = new Map<string, MouseReport>();

  constructor(private readonly send: (op: TmuxOp) => void) {}

  /**
   * Take an input op into the batch (it is then sent, now or with the
   * window); false for any other op, which the caller sends itself. Key names
   * that start with a flag (`-X cancel`, `-N 3 Up`) are sent alone: joined
   * with others, the flag would apply to keys it was never meant for.
   */
  take(op: TmuxOp): boolean {
    if (op._tag === 'SendText') return this.add(this.text, op.target, [op.text]);
    if (op._tag === 'SendKeys' && !op.keys.startsWith('-')) {
      return this.add(this.keys, op.target, [op.keys]);
    }
    if (op._tag === 'SendMouse') return this.add(this.mouse, op.paneId, this.moved(op));
    return false;
  }

  hasPending(): boolean {
    return this.batches.some((batch) => batch.hasPending());
  }

  /** Send everything pending now and close the windows: before an op that must not overtake it. */
  flushAll(): void {
    for (const batch of this.batches) {
      batch.closeWindow();
      this.flush(batch);
    }
  }

  destroy(): void {
    for (const batch of this.batches) {
      batch.closeWindow();
      batch.pending.clear();
    }
    this.lastReport.clear();
  }

  /** The reports of `op` that say something the one before them did not. */
  private moved(op: Extract<TmuxOp, { _tag: 'SendMouse' }>): MouseReport[] {
    const fresh: MouseReport[] = [];
    for (const report of op.reports) {
      const last = this.lastReport.get(op.paneId);
      if (last && isMouseMotion(report) && sameReport(last, report)) continue;
      this.lastReport.set(op.paneId, report);
      fresh.push(report);
    }
    return fresh;
  }

  private add<P extends Part>(batch: Batch<P>, target: string, parts: P[]): true {
    if (parts.length === 0) return true;
    for (const other of this.batches) if (other !== batch) this.flushTarget(other, target);
    if (batch.window === null) {
      this.send(this.opFor(batch.kind, target, parts));
      batch.window = this.openWindow(batch);
      return true;
    }
    const pending = batch.pending.get(target) ?? [];
    for (const part of parts) {
      const waiting = pending[pending.length - 1];
      const supersedes =
        typeof part !== 'string' &&
        typeof waiting === 'object' &&
        isMouseMotion(part) &&
        isMouseMotion(waiting) &&
        part.button === waiting.button;
      if (supersedes) pending[pending.length - 1] = part;
      else pending.push(part);
    }
    batch.pending.set(target, pending);
    return true;
  }

  private openWindow(batch: Batch): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      batch.window = null;
      // Under sustained input the window stays open so the stream keeps
      // coalescing; an empty one closes and the next input is leading again.
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

  private opFor(kind: Kind, target: string, parts: ReadonlyArray<Part>): TmuxOp {
    switch (kind) {
      case 'keys':
        return TmuxOp.SendKeys({ target, keys: parts.join(' ') });
      case 'text':
        return TmuxOp.SendText({ target, text: parts.join('') });
      case 'mouse':
        return TmuxOp.SendMouse({
          paneId: target as Extract<TmuxOp, { _tag: 'SendMouse' }>['paneId'],
          reports: parts as ReadonlyArray<MouseReport>,
        });
    }
  }
}
