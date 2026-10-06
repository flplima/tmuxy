/**
 * The TypeScript half of the Rust ↔ TS protocol contract.
 *
 * `packages/protocol-fixtures/` holds canonical wire payloads serialized by
 * the Rust types (see `packages/tmuxy-server/src/sse.rs`, `mod
 * protocol_fixtures`). Nothing generates the TS schemas (`domain/wire.ts`)
 * from those types — they mirror them by hand — so a field that drifts is
 * invisible to both suites. `history_size` reached production that way. These
 * tests decode the committed fixtures through the real schemas and fail when a
 * field the server sends does not survive the trip.
 *
 * Regenerate the fixtures with:
 *   UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-server protocol_fixtures
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';

import {
  ClipboardEvent,
  ConnectionInfo,
  DetachedEvent,
  KeyBindings,
  LogEvent,
  MessageFrame,
  ServerState as ServerStateSchema,
  ThemeSettings,
  type ServerState,
} from '../../domain/wire';
import { handleStateUpdate, applyDelta } from '../deltaProtocol';
import { toClientState } from '../../domain/client';
import { wireDelta, wireUpdate } from '../../test/wire';

/** Vite serves modules under an `/@fs` prefix; `fs` wants the real path. */
const FIXTURE_DIR = new URL('../../../../protocol-fixtures', import.meta.url).pathname.replace(
  /^\/@fs/,
  '',
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8'));
}

/**
 * Every key the server put on the wire for this object, minus the ones the
 * decoded object still carries. A non-empty result is drift: the schema does
 * not model a field the server sends, so decoding silently drops it.
 */
function droppedKeys(sent: Record<string, unknown>, decoded: Record<string, unknown>): string[] {
  return Object.keys(sent).filter((key) => !(key in decoded));
}

describe('Rust → TypeScript protocol fixtures', () => {
  const initial = fixture('get_initial_state.json') as { result: Record<string, unknown> };

  it('decodes the get_initial_state response without dropping a field', () => {
    const sent = initial.result;
    const decoded = Schema.decodeUnknownSync(ServerStateSchema)(sent) as unknown as Record<
      string,
      unknown
    >;

    expect(droppedKeys(sent, decoded)).toEqual([]);

    const sentPanes = sent.panes as Record<string, unknown>[];
    const decodedPanes = decoded.panes as Record<string, unknown>[];
    expect(decodedPanes).toHaveLength(sentPanes.length);
    sentPanes.forEach((pane, i) => {
      expect(droppedKeys(pane, decodedPanes[i])).toEqual([]);
    });

    const sentWindows = sent.windows as Record<string, unknown>[];
    const decodedWindows = decoded.windows as Record<string, unknown>[];
    expect(decodedWindows).toHaveLength(sentWindows.length);
    sentWindows.forEach((window, i) => {
      expect(droppedKeys(window, decodedWindows[i])).toEqual([]);
    });

    // The field that escaped: present on the wire, and it has to survive.
    expect(decodedPanes[0].history_size).toBe(1234);
  });

  it('carries every pane and window field into the client model', () => {
    const sent = initial.result as {
      panes: Record<string, unknown>[];
      windows: Record<string, unknown>[];
    };
    const client = toClientState(Schema.decodeUnknownSync(ServerStateSchema)(sent));
    const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    // Read by the shell side only; the client does not model it.
    const notModelled = new Set(['pane_restore']);
    const missing = (sentRecord: Record<string, unknown>, decoded: object) =>
      Object.keys(sentRecord).filter((key) => !notModelled.has(key) && !(camel(key) in decoded));
    sent.panes.forEach((pane, i) => expect(missing(pane, client.panes[i])).toEqual([]));
    for (const window of sent.windows) {
      const decoded = client.windows.find((w) => w.id === window.id);
      expect(missing(window, decoded!)).toEqual([]);
    }
  });

  it('applies the canonical delta frame on top of the canonical full state', () => {
    const full = fixture('sse_state_update_full.json') as { event: string; data: unknown };
    const delta = fixture('sse_state_update_delta.json') as { event: string; data: unknown };

    expect(full.event).toBe('state-update');
    expect(delta.event).toBe('state-update');

    const state = handleStateUpdate(wireUpdate(full.data), null);
    expect(state).not.toBeNull();
    const before = state as ServerState;
    expect(before.panes.map((p) => p.tmux_id)).toEqual(['%2', '%3']);

    const after = handleStateUpdate(wireUpdate(delta.data), before) as ServerState;

    // Every merge path the delta exercises, end to end.
    expect(after.active_pane_id).toBe('%4');
    expect(after.active_window_id).toBe('@2');
    expect(after.total_width).toBe(100);
    expect(after.panes.map((p) => p.tmux_id).sort()).toEqual(['%2', '%4']);
    expect(after.windows.map((w) => w.id).sort()).toEqual(['@1', '@3']);

    const updated = after.panes.find((p) => p.tmux_id === '%2');
    expect(updated?.history_size).toBe(4321);
    expect(updated?.pane_state).toBe('idle');
    expect(updated?.group_id).toBeNull();
    expect(updated?.window_id).toBe('@2');
    // The sparse content map is keyed by line index; line 1 is replaced and
    // line 0 is kept.
    expect(updated?.content[0].map((c) => c.c).join('')).toBe('hi');
    expect(updated?.content[1].map((c) => c.c).join('')).toBe('xy');

    const renamed = after.windows.find((w) => w.id === '@1');
    expect(renamed?.name).toBe('renamed');
    expect(renamed?.window_type).toBe('sidebar-left');
    expect(renamed?.active_pane_id).toBe('%4');
  });

  it('keeps every pane field the server can send reachable through applyDelta', () => {
    const full = fixture('sse_state_update_full.json') as { data: unknown };
    const delta = fixture('sse_state_update_delta.json') as {
      data: {
        type: 'delta';
        delta: { seq: number; panes: Record<string, Record<string, unknown>> };
      };
    };
    const state = handleStateUpdate(wireUpdate(full.data), null) as ServerState;
    const merged = applyDelta(state, wireDelta(delta.data.delta));

    const paneDelta = delta.data.delta.panes['%2'];
    const pane = merged.panes.find((p) => p.tmux_id === '%2') as unknown as Record<string, unknown>;
    // `content` is merged sparsely rather than assigned, so it is checked
    // above instead; every other field must land verbatim.
    const unmerged = Object.keys(paneDelta).filter((key) => key !== 'content' && !(key in pane));
    expect(unmerged).toEqual([]);
  });

  it('reads every SSE frame the server can emit', () => {
    const frames = fixture('sse_frames.json') as { event: string; data: unknown }[];
    // The names the HttpAdapter subscribes to. A frame whose name is not here
    // is dispatched to no listener in the browser at all.
    const handled = new Set([
      'connection-info',
      'state-update',
      'keybindings',
      'theme-settings',
      'tmux-error',
      'clipboard',
      'log',
      'detached',
      'fatal',
    ]);
    // The schema each listener decodes its frame with.
    const schemas = new Map<string, (data: unknown) => unknown>([
      ['connection-info', Schema.decodeUnknownSync(ConnectionInfo)],
      ['keybindings', Schema.decodeUnknownSync(KeyBindings)],
      ['theme-settings', Schema.decodeUnknownSync(ThemeSettings)],
      ['tmux-error', Schema.decodeUnknownSync(MessageFrame)],
      ['clipboard', Schema.decodeUnknownSync(ClipboardEvent)],
      ['log', Schema.decodeUnknownSync(LogEvent)],
      ['detached', Schema.decodeUnknownSync(DetachedEvent)],
      ['fatal', Schema.decodeUnknownSync(MessageFrame)],
    ]);
    for (const frame of frames) {
      expect(handled.has(frame.event), `no client listener for SSE event "${frame.event}"`).toBe(
        true,
      );
      const decode = schemas.get(frame.event);
      expect(decode, `no schema for SSE event "${frame.event}"`).toBeDefined();
      expect(() => decode!(frame.data)).not.toThrow();
    }
  });

  it('reads the /commands error envelope', () => {
    const bodies = fixture('command_errors.json') as { result?: unknown; error?: string }[];
    for (const body of bodies) {
      // The adapter branches on `error` being present; `result` is omitted
      // entirely, not sent as null.
      expect(body.error).toBeTypeOf('string');
      expect('result' in body).toBe(false);
    }
  });
});
