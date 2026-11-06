import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tracer } from '../tracer';

const here = dirname(fileURLToPath(import.meta.url));

/** The string literals of the list a `const <name> = …[ … ]` holds. */
function listed(source: string, start: RegExp): string[] {
  const at = source.indexOf('[', source.indexOf('=', source.search(start)));
  const body = source.slice(at, source.indexOf(']', at));
  return [...body.matchAll(/'([a-z_]+)'|"([a-z_]+)"/g)].map((m) => m[1] ?? m[2]);
}

describe('the client allowlist', () => {
  // The server re-applies its own policy (tmuxy-core trace::schema) to every
  // client event, so a key the client ships that the server does not admit
  // is a key the client thinks it records and never does.
  it('ships only keys the server records', () => {
    const rust = readFileSync(resolve(here, '../../../../tmuxy-core/src/trace/schema.rs'), 'utf8');
    const admitted = new Set(
      ['STRUCTURAL', 'VERBATIM', 'HASHED', 'SCRUBBED', 'CLIENT_NUMBERS'].flatMap((name) =>
        listed(rust, new RegExp(`pub const ${name}: `)),
      ),
    );
    const client = listed(
      readFileSync(resolve(here, '../tracer.ts'), 'utf8'),
      /const ALLOWED_KEYS/,
    );
    expect(client.length).toBeGreaterThan(10);
    for (const key of client) expect(admitted.has(key), key).toBe(true);
  });
});

describe('tracer redaction boundary', () => {
  beforeEach(() => {
    tracer.setEnabled(true);
    tracer.setSink(null);
  });

  afterEach(() => {
    tracer.setEnabled(false);
    tracer.setSink(null);
  });

  it('ships only allowlisted keys and drops content-bearing fields', () => {
    let shipped: Record<string, unknown>[] = [];
    tracer.setSink((events) => {
      shipped = events;
    });

    tracer.event({
      layer: 'xstate',
      name: 'SEND_TMUX_COMMAND',
      op: 'split-window',
      pane: '%3',
      // Fields a careless caller might attach that would leak terminal content —
      // none of these are on the allowlist and must never be shipped.
      command: 'send-keys -l secret-password',
      keys: 'password123',
      text: 'rm -rf /',
    } as never);
    tracer.flush();

    expect(shipped).toHaveLength(1);
    const ev = shipped[0];
    expect(ev.layer).toBe('xstate');
    expect(ev.name).toBe('SEND_TMUX_COMMAND');
    expect(ev.op).toBe('split-window');
    expect(ev.pane).toBe('%3');
    expect(ev).not.toHaveProperty('command');
    expect(ev).not.toHaveProperty('keys');
    expect(ev).not.toHaveProperty('text');

    // Every shipped value must be a primitive — no nested object could smuggle
    // content through, and NDJSON stays one flat record per line.
    for (const value of Object.values(ev)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('stamps timing and defaults the phase', () => {
    let shipped: Record<string, unknown>[] = [];
    tracer.setSink((events) => {
      shipped = events;
    });
    tracer.event({ layer: 'adapter', name: 'send', kind: 'keys' });
    tracer.flush();

    expect(shipped[0].phase).toBe('event');
    expect(typeof shipped[0].ts_wall).toBe('number');
    expect(typeof shipped[0].ts_mono).toBe('number');
    expect(shipped[0].kind).toBe('keys');
  });

  it('coalesces high-frequency events into a single count', () => {
    let shipped: Record<string, unknown>[] = [];
    tracer.setSink((events) => {
      shipped = events;
    });
    tracer.count('xstate', 'TMUX_MODEL_UPDATE');
    tracer.count('xstate', 'TMUX_MODEL_UPDATE');
    tracer.count('xstate', 'TMUX_MODEL_UPDATE');
    tracer.event({ layer: 'store', name: 'Split', kind: 'horizontal' });
    tracer.flush();

    const counts = shipped.filter((e) => e.phase === 'count');
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({
      layer: 'xstate',
      name: 'TMUX_MODEL_UPDATE',
      count: 3,
    });
    expect(shipped.some((e) => e.name === 'Split' && e.kind === 'horizontal')).toBe(true);
  });

  it('is a no-op when disabled', () => {
    tracer.setEnabled(false);
    let shipped = 0;
    tracer.setSink(() => {
      shipped++;
    });
    tracer.event({ layer: 'xstate', name: 'X' });
    tracer.flush();
    expect(shipped).toBe(0);
  });
});
