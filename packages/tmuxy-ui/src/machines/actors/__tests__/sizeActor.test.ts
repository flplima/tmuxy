import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, type AnyActorRef } from 'xstate';
import { createSizeActor } from '../sizeActor';

class RecordingObserver {
  static live = new Set<RecordingObserver>();
  constructor(_callback: ResizeObserverCallback) {}
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
});
