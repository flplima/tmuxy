import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendCall } from '../../../../../domain/backendCalls';
import { GuestEngine } from '../GuestEngine';
import { GuestTmuxAdapter } from '../GuestTmuxAdapter';
import { IN_VIEW_RATIO, PAUSE_GRACE_MS, PAUSE_RETRY_MS, PausePolicy } from '../pausePolicy';

/** The one observer the policy makes; the test reports what it sees. */
const observers: FakeObserver[] = [];
class FakeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  constructor(readonly callback: (entries: { intersectionRatio: number }[]) => void) {
    observers.push(this);
  }
  see(ratio: number) {
    this.callback([{ intersectionRatio: ratio }]);
  }
}

function setTabVisible(visible: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

const SNAPSHOT = { url: '/state.bin', session: 'm' };

let element: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  element = document.body.appendChild(document.createElement('div'));
  element.appendChild(document.createElement('textarea'));
  setTabVisible(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  element.remove();
});

function policy(pause: () => boolean = () => true) {
  const engine = { pause: vi.fn(pause), resume: vi.fn() };
  const watching = new PausePolicy(engine, () => element);
  watching.start();
  return { engine, watching, observer: observers[0] };
}

describe('when the guest is paused', () => {
  it('waits out a grace after the element leaves the view, and runs again at once on its return', () => {
    const { engine, observer } = policy();
    observer.see(0);
    vi.advanceTimersByTime(PAUSE_GRACE_MS - 1);
    expect(engine.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(engine.pause).toHaveBeenCalledTimes(1);

    observer.see(1);
    expect(engine.resume).toHaveBeenCalled();
  });

  it('does not pause for a scroll past that comes back inside the grace', () => {
    const { engine, observer } = policy();
    observer.see(0);
    vi.advanceTimersByTime(PAUSE_GRACE_MS - 100);
    observer.see(1);
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    expect(engine.pause).not.toHaveBeenCalled();
  });

  it('treats a sliver of the element as out of view, unless focus is inside it', () => {
    const { engine, observer } = policy();
    observer.see(IN_VIEW_RATIO / 2);
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    expect(engine.pause).toHaveBeenCalledTimes(1);

    element.querySelector('textarea')?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(engine.resume).toHaveBeenCalled();
    engine.pause.mockClear();
    observer.see(0);
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    expect(engine.pause).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden even with the element in view, and resumes when it shows', () => {
    const { engine } = policy();
    setTabVisible(false);
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    expect(engine.pause).toHaveBeenCalledTimes(1);
    setTabVisible(true);
    expect(engine.resume).toHaveBeenCalled();
  });

  it('asks again while the engine refuses, and stops asking once it is looked at', () => {
    let refuse = 2;
    const { engine, observer } = policy(() => refuse-- <= 0);
    observer.see(0);
    vi.advanceTimersByTime(PAUSE_GRACE_MS + 2 * PAUSE_RETRY_MS);
    expect(engine.pause).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10 * PAUSE_RETRY_MS);
    expect(engine.pause).toHaveBeenCalledTimes(3);

    refuse = 100;
    engine.pause.mockClear();
    observer.see(1);
    observer.see(0);
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    observer.see(1);
    vi.advanceTimersByTime(10 * PAUSE_RETRY_MS);
    expect(engine.pause).toHaveBeenCalledTimes(1);
  });

  it('runs the guest again and lets go of the page when stopped', () => {
    const { engine, watching, observer } = policy();
    watching.stop();
    expect(engine.resume).toHaveBeenCalled();
    expect(observer.disconnect).toHaveBeenCalled();
    setTabVisible(false);
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    expect(engine.pause).not.toHaveBeenCalled();
  });
});

/** An engine that attaches at once and records pauses. */
class QuietEngine extends GuestEngine {
  send = vi.fn();
  pause = vi.fn(() => true);
  protected async doBoot(): Promise<void> {}
  protected async doReset(): Promise<void> {}
  protected teardown(): void {}
  protected haltMachine(): void {}
  protected continueMachine(): void {}
}

async function firstFrame(adapter: GuestTmuxAdapter) {
  await adapter.connect();
  await adapter.send(backendCall('get_initial_state', { cols: 0, rows: 0 }));
}

describe('the adapter option', () => {
  const pauseWhenHidden = { target: () => element };

  it('creates no observer when it is off, or when the engine is shared', async () => {
    await firstFrame(new GuestTmuxAdapter(new QuietEngine(), true, SNAPSHOT));
    await firstFrame(new GuestTmuxAdapter(new QuietEngine(), false, SNAPSHOT, { pauseWhenHidden }));
    expect(observers).toEqual([]);
  });

  it('starts watching at the first frame, not before, and lets go on disconnect', async () => {
    const adapter = new GuestTmuxAdapter(new QuietEngine(), true, SNAPSHOT, { pauseWhenHidden });
    await adapter.connect();
    expect(observers).toEqual([]);
    await adapter.send(backendCall('get_initial_state', { cols: 0, rows: 0 }));
    expect(observers).toHaveLength(1);
    adapter.disconnect();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});
