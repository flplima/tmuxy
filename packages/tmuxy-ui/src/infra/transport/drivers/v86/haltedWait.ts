/**
 * How the machine waits while its guest is halted.
 *
 * v86 runs the CPU in slices and yields to the event loop between them: at
 * once while the guest is busy, and for the time to the guest's next timer
 * while it is halted. A wait under a millisecond it takes as no wait at all,
 * and a timer wakes a little early: at the end of every tick of the guest's
 * kernel (250 a second) the machine asks to wait a fraction of a millisecond
 * and is woken at once, slice after empty slice, until the tick is due. That
 * is a third of a core for a guest doing nothing.
 *
 * Here a halted machine waits a millisecond at least, so a tick is up to a
 * millisecond late, and a busy one yields at once as before. The wait is a
 * `scheduler.postTask`: a timeout set from a timeout's own callback is held
 * to 4 ms by the browser, a whole tick. Where there is no such scheduler
 * (Safari), v86's own way of yielding stays.
 */

/** The part of v86's machine (`emulator.v86`) that yields between slices. */
export interface YieldingMachine {
  /** Come back after `ms` (0 while the guest is busy) with `tick`. */
  yield(ms: number, tick: number): void;
  /** Run the next slice, if `tick` is still the last one asked for. */
  yield_callback(tick: number): void;
  /** v86's own yield goes through a worker it starts on each run and ends on each stop. */
  register_yield(): void;
  unregister_yield(): void;
}

interface TaskScheduler {
  postTask(task: () => void, options?: { delay?: number }): Promise<unknown>;
}

/** The shortest wait of a halted machine. */
export const HALTED_WAIT_MIN_MS = 1;

/**
 * Have `machine` wait through `scheduler` between slices. False, with the
 * machine left as it is, where there is no scheduler or the machine is not
 * the shape this was written against.
 */
export function waitWhileHalted(
  machine: Partial<YieldingMachine>,
  scheduler: TaskScheduler | undefined = (globalThis as { scheduler?: TaskScheduler }).scheduler,
): boolean {
  const next = machine.yield_callback;
  if (typeof scheduler?.postTask !== 'function') return false;
  if (typeof machine.yield !== 'function' || typeof next !== 'function') return false;
  machine.yield = (ms, tick) => {
    const delay = ms > 0 ? Math.max(HALTED_WAIT_MIN_MS, ms) : 0;
    void scheduler.postTask(() => next.call(machine, tick), { delay });
  };
  machine.register_yield = () => {};
  machine.unregister_yield = () => {};
  return true;
}
