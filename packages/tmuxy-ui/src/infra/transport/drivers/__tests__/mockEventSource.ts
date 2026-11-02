/**
 * A scripted EventSource for the HTTP driver's tests — jsdom ships none. It
 * records every instance so a test can assert how many streams were opened
 * and whether stale ones were closed (the duplicate-stream / orphan-leak bug
 * lives exactly here).
 */

import { expect, vi } from 'vitest';

export class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onerror: ((e: unknown) => void) | null = null;
  private listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
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
  const original = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
  return () => {
    (globalThis as Record<string, unknown>).EventSource = original;
  };
}

export const openStreams = () => MockEventSource.instances.filter((e) => !e.closed);

/**
 * The i-th stream opened, once it exists. The channel opens its EventSource
 * on a microtask (the Effect fiber), so a test must await the stream's
 * existence before driving it; the fiber itself is created synchronously by
 * connect(), so dedupe still holds immediately.
 */
export const stream = async (i: number): Promise<MockEventSource> => {
  await vi.waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(i));
  return MockEventSource.instances[i];
};
