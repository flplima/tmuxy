import { describe, it, expect } from 'vitest';
import {
  TransportError,
  ProtocolError,
  TmuxError,
  Cancelled,
  classifyAdapterError,
} from '../AdapterError';

describe('AdapterError ADT', () => {
  it('TransportError is _tag-tagged for exhaustive matching', () => {
    const e = new TransportError({ cause: 'network down' });
    expect(e._tag).toBe('TransportError');
  });

  it('ProtocolError captures reason and raw payload', () => {
    const e = new ProtocolError({ reason: 'invalid JSON', raw: '{...' });
    expect(e._tag).toBe('ProtocolError');
    expect(e.reason).toBe('invalid JSON');
    expect(e.raw).toBe('{...');
  });

  it('TmuxError captures command and stderr', () => {
    const e = new TmuxError({ command: 'kill-pane', stderr: 'no such pane' });
    expect(e._tag).toBe('TmuxError');
    expect(e.command).toBe('kill-pane');
    expect(e.stderr).toBe('no such pane');
  });

  it('Cancelled is distinguishable from other errors', () => {
    const e = new Cancelled({ reason: 'fiber interrupted' });
    expect(e._tag).toBe('Cancelled');
  });
});

describe('classifyAdapterError', () => {
  it('passes through already-tagged errors unchanged', () => {
    const original = new TmuxError({ command: 'x', stderr: 'y' });
    expect(classifyAdapterError(original)).toBe(original);
  });

  it('recognizes Rust backend { error: "..." } shape as TmuxError', () => {
    const result = classifyAdapterError(
      { error: 'no such pane: %999' },
      { command: 'kill-pane -t %999' },
    );
    expect(result._tag).toBe('TmuxError');
    if (result._tag === 'TmuxError') {
      expect(result.command).toBe('kill-pane -t %999');
      expect(result.stderr).toBe('no such pane: %999');
    }
  });

  it('classifies plain-string rejection as TransportError', () => {
    const result = classifyAdapterError('connection refused', { command: 'connect' });
    expect(result._tag).toBe('TransportError');
    if (result._tag === 'TransportError') {
      expect(result.cause).toBe('connection refused');
      expect(result.context).toBe('connect');
    }
  });

  it('classifies Error instance as TransportError preserving cause', () => {
    const err = new Error('socket hang up');
    const result = classifyAdapterError(err);
    expect(result._tag).toBe('TransportError');
    if (result._tag === 'TransportError') {
      expect(result.cause).toBe(err);
    }
  });

  it('falls back to TransportError for unknown shapes (never throws)', () => {
    const result = classifyAdapterError({ weird: 'object' });
    expect(result._tag).toBe('TransportError');
  });

  it('falls back to TransportError for null cause', () => {
    const result = classifyAdapterError(null);
    expect(result._tag).toBe('TransportError');
  });
});
