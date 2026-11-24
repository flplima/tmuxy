import { describe, expect, it, vi } from 'vitest';
import { waitWhileHalted, type YieldingMachine } from '../haltedWait';

/** v86's machine, as far as yielding goes: its own yield bounces off a worker. */
function fakeMachine() {
  const ran: number[] = [];
  const own = { yield: vi.fn(), register: vi.fn(), unregister: vi.fn() };
  const machine: YieldingMachine = {
    yield: own.yield,
    yield_callback(tick) {
      ran.push(tick);
    },
    register_yield: own.register,
    unregister_yield: own.unregister,
  };
  return { machine, ran, own };
}

/** A scheduler that keeps its tasks, to be run by the test. */
function fakeScheduler() {
  const tasks: { run: () => void; delay: number }[] = [];
  return {
    tasks,
    postTask(run: () => void, options?: { delay?: number }) {
      tasks.push({ run, delay: options?.delay ?? 0 });
      return Promise.resolve();
    },
  };
}

describe('waitWhileHalted', () => {
  it('yields at once while the guest is busy', () => {
    const { machine, ran } = fakeMachine();
    const scheduler = fakeScheduler();
    expect(waitWhileHalted(machine, scheduler)).toBe(true);

    machine.yield(0, 7);
    expect(scheduler.tasks.map((t) => t.delay)).toEqual([0]);
    scheduler.tasks[0].run();
    expect(ran).toEqual([7]);
  });

  it('waits a millisecond at least while the guest is halted, and the time asked past that', () => {
    const { machine, ran } = fakeMachine();
    const scheduler = fakeScheduler();
    waitWhileHalted(machine, scheduler);

    machine.yield(0.2, 1);
    machine.yield(3.8, 2);
    expect(scheduler.tasks.map((t) => t.delay)).toEqual([1, 3.8]);
    for (const task of scheduler.tasks) task.run();
    expect(ran).toEqual([1, 2]);
  });

  it("starts no worker for v86's own yield", () => {
    const { machine, own } = fakeMachine();
    waitWhileHalted(machine, fakeScheduler());

    machine.register_yield();
    machine.yield(0, 1);
    machine.unregister_yield();
    expect(own.register).not.toHaveBeenCalled();
    expect(own.yield).not.toHaveBeenCalled();
    expect(own.unregister).not.toHaveBeenCalled();
  });

  it('leaves the machine as it is where there is no scheduler', () => {
    const { machine, own } = fakeMachine();
    expect(waitWhileHalted(machine, undefined)).toBe(false);
    expect(machine.yield).toBe(own.yield);
    expect(machine.register_yield).toBe(own.register);
  });

  it('leaves a machine of another shape as it is', () => {
    const machine = { register_yield: vi.fn() };
    const scheduler = fakeScheduler();
    expect(waitWhileHalted(machine, scheduler)).toBe(false);
    expect(Object.keys(machine)).toEqual(['register_yield']);
  });
});
