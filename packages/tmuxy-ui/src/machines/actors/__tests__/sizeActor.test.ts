import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, type AnyActorRef } from 'xstate';
import { createSizeActor } from '../sizeActor';

class RecordingObserver {
  static live = new Set<RecordingObserver>();
  constructor(readonly callback: ResizeObserverCallback) {}
  /** Report a content box, as a real observer does after layout. */
  report(width: number, height: number) {
    this.callback(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  observe() {
    RecordingObserver.live.add(this);
  }
  disconnect() {
    RecordingObserver.live.delete(this);
  }
  unobserve() {}
}

afterEach(() => {
  RecordingObserver.live.clear();
  vi.unstubAllGlobals();
});

describe('sizeActor', () => {
  it('stops observing the container and the app body when it stops', () => {
    vi.stubGlobal('ResizeObserver', RecordingObserver);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise(() => {}) },
    });
    const body = document.createElement('div');
    body.className = 'app-body';
    const container = document.createElement('div');
    body.appendChild(container);

    const parent = { send: () => {} } as unknown as AnyActorRef;
    const sizeActor = createSizeActor(() => ({ advance: 8, cellWidth: 8, cellGap: 0 }));
    const actor = createActor(sizeActor, { input: { parent } }).start();

    actor.send({ type: 'OBSERVE_CONTAINER', element: container });
    expect(RecordingObserver.live.size).toBe(2);

    actor.stop();
    expect(RecordingObserver.live.size).toBe(0);
  });

  it('on a phone asks for 80 × 24 and cuts the cell from the container width', () => {
    vi.stubGlobal('ResizeObserver', RecordingObserver);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise(() => {}) },
    });
    const body = document.createElement('div');
    body.className = 'app-body';
    const container = document.createElement('div');
    body.appendChild(container);

    const sent: Array<Record<string, unknown>> = [];
    const parent = { send: (e: Record<string, unknown>) => sent.push(e) } as unknown as AnyActorRef;
    // FiraCode at the default 15px: a 9px advance, 0.6px per px of type.
    const sizeActor = createSizeActor(() => ({ advance: 9, cellWidth: 9, cellGap: 0 }), {
      phoneLayout: true,
    });
    const actor = createActor(sizeActor, { input: { parent } }).start();
    actor.send({ type: 'OBSERVE_CONTAINER', element: container });
    const [containerObserver] = RecordingObserver.live;
    containerObserver.report(366, 300);

    expect(sent).toContainEqual({ type: 'SET_PHONE_LAYOUT', phone: true });
    const cell = sent.filter((e) => e.type === 'SET_CHAR_SIZE').slice(-1)[0];
    expect(cell.gridFontSize).toBeLessThan(8);
    expect((cell.charWidth as number) * 80).toBeLessThanOrEqual(366);
    expect(sent.filter((e) => e.type === 'SET_TARGET_SIZE').slice(-1)[0]).toEqual({
      type: 'SET_TARGET_SIZE',
      cols: 80,
      rows: 24,
    });
    actor.stop();
  });
});
