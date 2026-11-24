import { describe, expect, it } from 'vitest';
import type { AnyActorRef } from 'xstate';
import { claimTypedText } from '../modalAndCopyKeys';
import type { KeyContext } from '../../../selectors/keyboard';
import type { PaneAsk } from '../../../../domain/paneAsk';
import type { PaneId } from '../../../../domain/ids';

const PANE = '%3' as PaneId;

/** What a phone keyboard typed, against the pane's question; the events it raised and the text left for the pane. */
function typed(text: string, over: { ask?: PaneAsk | null; closePending?: boolean }) {
  const sent: unknown[] = [];
  const parent = { send: (event: unknown) => sent.push(event) } as unknown as AnyActorRef;
  const keys = {
    focusPaneId: PANE,
    ask: over.ask ?? null,
    closePending: over.closePending ?? false,
  } as KeyContext;
  return { left: claimTypedText(text, parent, keys), sent };
}

const send: PaneAsk = { kind: 'send', token: 't', caller: 'agent', keys: ['ls'] };
const question: PaneAsk = {
  kind: 'question',
  token: 't',
  caller: 'agent',
  question: 'Deploy?',
  choices: ['yes', 'no', 'later'],
  text: false,
};

describe('claimTypedText', () => {
  it('hands each character to a send or a question as its key, and none to the pane', () => {
    for (const ask of [send, question]) {
      expect(typed('2', { ask })).toEqual({
        left: '',
        sent: [{ type: 'ASK_KEY', paneId: PANE, key: '2' }],
      });
    }
    expect(typed('ab', { ask: question }).sent).toEqual([
      { type: 'ASK_KEY', paneId: PANE, key: 'a' },
      { type: 'ASK_KEY', paneId: PANE, key: 'b' },
    ]);
  });

  it('declines an offer and types on, as a key pressed does', () => {
    const offer: PaneAsk = { kind: 'offer', token: 't', command: 'npm run dev' };
    expect(typed('ls', { ask: offer })).toEqual({
      left: 'ls',
      sent: [{ type: 'ASK_KEY', paneId: PANE, key: 'ls' }],
    });
  });

  it('types nothing into the pane behind the close confirmation', () => {
    expect(typed('y', { closePending: true })).toEqual({ left: '', sent: [] });
  });

  it('leaves text with no question up to the pane', () => {
    expect(typed('ls', {})).toEqual({ left: 'ls', sent: [] });
  });
});
