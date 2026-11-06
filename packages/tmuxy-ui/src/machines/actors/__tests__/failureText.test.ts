import { describe, it, expect, vi } from 'vitest';
import { Cause, FiberId } from 'effect';
import { failureText } from '../failureText';
import { OpRejectedByTmux, OpTransportError, type OpId } from '../../../domain/store/types';
import { TmuxError } from '../../../infra/transport/AdapterError';

const opId = 'op1' as OpId;

describe('what a failed request tells the user', () => {
  it('a refusal shows what tmux said, a lost link the transport’s reason', () => {
    expect(
      failureText(
        Cause.fail(new OpRejectedByTmux({ opId, command: 'kill-pane', stderr: 'no pane' })),
      ),
    ).toBe('no pane');
    expect(
      failureText(Cause.fail(new OpTransportError({ opId, command: 'x', reason: 'offline' }))),
    ).toBe('offline');
    expect(failureText(Cause.fail(new TmuxError({ command: 'x', stderr: 'bad option' })))).toMatch(
      /bad option/,
    );
  });

  it('a throw inside a driver is logged and reported, never dropped in silence', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(failureText(Cause.die(new Error('decoder blew up')))).toMatch(/internal error/);
    expect(errors).toHaveBeenCalledWith(
      '[tmuxy] defect:',
      expect.stringMatching(/decoder blew up/),
    );
    errors.mockRestore();
  });

  it('an interrupted request reports nothing', () => {
    expect(failureText(Cause.interrupt(FiberId.none))).toBeNull();
  });
});
