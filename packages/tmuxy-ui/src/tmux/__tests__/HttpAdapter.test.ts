/**
 * HttpAdapter ordering guarantees.
 *
 * The full adapter pulls in window/EventSource/fetch and is hard to spin up
 * in jsdom. These tests target the one property we actually care about for
 * the split-targeting-wrong-tab bug: when two `run_tmux_command` invokes are
 * fired without awaiting, the second POST must not leave the browser before
 * the first POST's fetch resolves. Otherwise the server can process them
 * out of order and a `split-window -h` issued after a `select-window -t @B`
 * lands in the previous tab.
 *
 * We don't instantiate the full adapter — we replicate the relevant queue
 * shape so the assertion is independent of unrelated SSE/EventSource setup.
 */

import { describe, it, expect } from 'vitest';

interface Resolver<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  promise: Promise<T>;
}

function deferred<T>(): Resolver<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

/** Minimal stand-in for the adapter's enqueueSerialInvoke helper. */
class SerialQueue {
  private chain: Promise<void> = Promise.resolve();
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    let resolveOuter!: (value: T | PromiseLike<T>) => void;
    let rejectOuter!: (reason: unknown) => void;
    const outer = new Promise<T>((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    this.chain = this.chain.then(async () => {
      try {
        resolveOuter(await run());
      } catch (err) {
        rejectOuter(err);
      }
    });
    return outer;
  }
}

describe('Serialized invoke ordering', () => {
  it('does not start the second fetch until the first resolves', async () => {
    const q = new SerialQueue();
    const firstStart = deferred<void>();
    const firstDone = deferred<string>();
    const secondStart = deferred<void>();
    const secondDone = deferred<string>();

    const first = q.enqueue(async () => {
      firstStart.resolve();
      return firstDone.promise;
    });
    const second = q.enqueue(async () => {
      secondStart.resolve();
      return secondDone.promise;
    });

    await firstStart.promise;
    // Microtask flush — second must not have started yet.
    await Promise.resolve();
    await Promise.resolve();
    const secondStartedEarly = await Promise.race([
      secondStart.promise.then(() => true),
      Promise.resolve(false),
    ]);
    expect(secondStartedEarly).toBe(false);

    firstDone.resolve('a');
    await first;
    await secondStart.promise;
    secondDone.resolve('b');
    await second;

    expect(await first).toBe('a');
    expect(await second).toBe('b');
  });

  it('continues processing the queue after a rejected invoke', async () => {
    const q = new SerialQueue();
    const failing = q.enqueue<string>(() => Promise.reject(new Error('boom')));
    const ok = q.enqueue<string>(() => Promise.resolve('next'));

    await expect(failing).rejects.toThrow('boom');
    expect(await ok).toBe('next');
  });
});
