import { describe, it, expect } from 'vitest';
import { TmuxError, classifyAdapterError, formatAdapterError } from '../AdapterError';

describe('classifyAdapterError', () => {
  it('passes through already-tagged errors unchanged', () => {
    const original = new TmuxError({ command: 'x', stderr: 'y' });
    expect(classifyAdapterError(original)).toBe(original);
  });

  it('types a command tmux refused (kind tmux) as TmuxError with its message', () => {
    const result = classifyAdapterError(
      { error: "can't find session: nope", kind: 'tmux' },
      { command: 'query_tmux' },
    );
    expect(result).toBeInstanceOf(TmuxError);
    expect(result).toMatchObject({ command: 'query_tmux', stderr: "can't find session: nope" });
  });

  it('types a missing tmux connection (kind unavailable) as TransportError', () => {
    const result = classifyAdapterError(
      { error: 'No monitor connection available', kind: 'unavailable' },
      { command: 'run_tmux_command' },
    );
    expect(result).toMatchObject({
      _tag: 'TransportError',
      cause: 'No monitor connection available',
      context: 'run_tmux_command',
    });
  });

  it('names the refusal for invalid and forbidden commands', () => {
    for (const kind of ['invalid', 'forbidden'] as const) {
      const result = classifyAdapterError(
        { error: 'read-only server', kind },
        { command: 'set_theme' },
      );
      expect(result._tag).toBe('TransportError');
      expect(formatAdapterError(result)).toBe(`set_theme refused (${kind}): read-only server`);
    }
  });

  it('does not take an error body without a kind for a tmux refusal', () => {
    expect(classifyAdapterError({ error: 'no such pane: %999' })._tag).toBe('TransportError');
  });

  it('classifies a plain-string rejection as TransportError', () => {
    const result = classifyAdapterError('connection refused', { command: 'connect' });
    expect(result).toMatchObject({
      _tag: 'TransportError',
      cause: 'connection refused',
      context: 'connect',
    });
  });

  it('keeps an Error instance message as the TransportError cause', () => {
    const result = classifyAdapterError(new Error('socket hang up'));
    expect(result).toMatchObject({ _tag: 'TransportError', cause: 'socket hang up' });
  });

  it('falls back to TransportError for unknown shapes and null (never throws)', () => {
    expect(classifyAdapterError({ weird: 'object' })._tag).toBe('TransportError');
    expect(classifyAdapterError(null)._tag).toBe('TransportError');
  });
});
