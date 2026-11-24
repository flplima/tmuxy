import { describe, expect, it, vi } from 'vitest';
import {
  connectMachine,
  type MachineEvent,
  type MachineHandlers,
  type MachinePort,
  type MachineRequest,
} from '../machine';

const GENERIC = '/v86-img/tmux-state.bin.zst';
const DEMO = '/v86-img/demo-state.bin.zst';

/** The page's end of a worker that answers only when the test says so. */
function fakeWorker() {
  const sent: { request: MachineRequest; transfer: Transferable[] }[] = [];
  const port: MachinePort = {
    postMessage: (request, transfer) => void sent.push({ request, transfer }),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminate: vi.fn(),
  };
  const handlers: MachineHandlers = { serial: vi.fn(), screen: vi.fn(), fatal: vi.fn() };
  const machine = connectMachine(port, handlers);
  const post = (event: MachineEvent) => port.onmessage?.({ data: event } as MessageEvent);
  const idOf = (type: string) => {
    const request = sent.find((s) => s.request.type === type)?.request;
    return request && 'id' in request ? request.id : -1;
  };
  const crash = (message?: string) =>
    port.onerror?.(Object.assign(new Event('error'), { message }) as ErrorEvent);
  return { port, handlers, machine, sent, post, idOf, crash };
}

describe('the machine worker, from the page', () => {
  it('answers each request by its id, with the reason when it failed', async () => {
    const { machine, post, idOf, sent } = fakeWorker();
    const boot = machine.boot(GENERIC);
    const restore = machine.restore(DEMO);
    expect(sent.map(({ request }) => request)).toEqual([
      { type: 'boot', url: GENERIC, id: idOf('boot') },
      { type: 'restore', url: DEMO, id: idOf('restore') },
    ]);
    post({ type: 'done', id: idOf('restore'), error: `guest snapshot ${DEMO}: HTTP 404` });
    post({ type: 'done', id: idOf('boot'), error: null });
    await expect(boot).resolves.toBeUndefined();
    await expect(restore).rejects.toThrow(`guest snapshot ${DEMO}: HTTP 404`);
  });

  it('fails a start that is waiting with the reason the worker died of, and every later call', async () => {
    const { machine, handlers, crash } = fakeWorker();
    const boot = machine.boot(GENERIC);
    crash('WebAssembly.compile(): expected magic word 00 61 73 6d');
    await expect(boot).rejects.toThrow('expected magic word');
    await expect(machine.restore(GENERIC)).rejects.toThrow('expected magic word');
    expect(handlers.fatal).not.toHaveBeenCalled();
  });

  it('names a worker whose script never loaded', async () => {
    const { machine, crash } = fakeWorker();
    const boot = machine.boot(GENERIC);
    crash();
    await expect(boot).rejects.toThrow("the guest machine's worker could not be loaded");
  });

  it('reports a failure with nothing waiting once, as fatal', () => {
    const { handlers, post, crash } = fakeWorker();
    post({ type: 'fatal', message: 'out of memory' });
    crash('and then this');
    expect(handlers.fatal).toHaveBeenCalledTimes(1);
    expect(handlers.fatal).toHaveBeenCalledWith('out of memory');
  });

  it('hands the guest output on and gives its own buffers away', () => {
    const { machine, handlers, post, sent } = fakeWorker();
    post({ type: 'serial', bytes: new Uint8Array([104, 105]) });
    expect(handlers.serial).toHaveBeenCalledWith(new Uint8Array([104, 105]));

    const bytes = new TextEncoder().encode('ls\n');
    machine.write(bytes);
    expect(sent[sent.length - 1]).toEqual({
      request: { type: 'write', bytes },
      transfer: [bytes.buffer],
    });
  });

  it('is destroyed without reporting it as a failure', async () => {
    const { machine, handlers, port, sent } = fakeWorker();
    const restore = machine.restore(GENERIC);
    machine.destroy();
    await expect(restore).rejects.toThrow('destroyed');
    expect(port.terminate).toHaveBeenCalled();
    machine.write(new Uint8Array([1]));
    expect(sent).toHaveLength(1);
    expect(handlers.fatal).not.toHaveBeenCalled();
  });
});
