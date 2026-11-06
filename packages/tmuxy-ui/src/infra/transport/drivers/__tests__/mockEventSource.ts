/**
 * A scripted EventSource for the HTTP driver's tests — jsdom ships none. It
 * records every instance so a test can assert how many streams were opened
 * and whether stale ones were closed (the duplicate-stream / orphan-leak bug
 * lives exactly here).
 */

export class MockEventSource {
  static instances: MockEventSource[] = [];
  /** Called once for each stream opened, then forgotten. */
  static onOpen: Array<() => void> = [];
  url: string;
  closed = false;
  onerror: ((e: unknown) => void) | null = null;
  private listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    for (const opened of MockEventSource.onOpen.splice(0)) opened();
  }
  addEventListener(type: string, cb: (e: { data: string }) => void): void {
    (this.listeners[type] ||= []).push(cb);
  }
  emit(type: string, payload: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(payload) });
  }
  close(): void {
    this.closed = true;
  }
}

/** Make `MockEventSource` the global EventSource; returns the restore function. */
export function installMockEventSource(): () => void {
  MockEventSource.instances = [];
  MockEventSource.onOpen = [];
  const original = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
  return () => {
    (globalThis as Record<string, unknown>).EventSource = original;
  };
}

export const openStreams = () => MockEventSource.instances.filter((e) => !e.closed);

/**
 * The i-th stream opened, once it is. The channel opens its EventSource on a
 * microtask (the Effect fiber), so a test must await the stream's existence
 * before driving it; the fiber itself is created synchronously by connect(),
 * so dedupe still holds immediately.
 */
export const stream = (i: number): Promise<MockEventSource> =>
  new Promise((resolve) => {
    const check = () => {
      if (MockEventSource.instances.length > i) resolve(MockEventSource.instances[i]);
      else MockEventSource.onOpen.push(check);
    };
    check();
  });
