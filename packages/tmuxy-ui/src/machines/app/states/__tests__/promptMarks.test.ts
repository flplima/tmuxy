import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { copyModeState } from '../copyMode';
import { copyModeActions } from '../../actions/copyMode';
import { mountState, sendAndGetContext } from './testHarness';
import type { TmuxPane } from '../../../../domain/client';
import type { PaneId } from '../../../../domain/ids';
import { cellLine, modelPane } from '../../../../test/model';
import { recorder } from '../../../../test/app';

const PANE = pid('%1');

/** A four-row pane with a hundred rows of history behind it. */
const makePane = (tmuxId: PaneId, extra: Partial<TmuxPane> = {}): TmuxPane =>
  modelPane(tmuxId, wid('@0'), {
    content: ['one', 'two', 'three', '$ '].map(cellLine),
    height: 4,
    active: true,
    historySize: 100,
    ...extra,
  });

function mount(pane: TmuxPane = makePane(PANE)) {
  const tmux = recorder();
  const actor = mountState(
    copyModeState,
    copyModeActions,
    { panes: [pane], activePaneId: pane.tmuxId },
    { extraActors: { tmux: tmux.logic } },
  );
  const asked = (type: string) => tmux.received.filter((event) => event.type === type);
  return { actor, tmux, asked };
}

describe('copyMode state: the shell prompts', () => {
  it('a view asks for its prompt rows when it opens, and keeps the answer', () => {
    const { actor, asked } = mount();
    sendAndGetContext(actor, { type: 'ENTER_SCROLL_MODE', paneId: PANE });
    expect(asked('FETCH_PROMPT_MARKS')).toEqual([{ type: 'FETCH_PROMPT_MARKS', paneId: PANE }]);

    const ctx = sendAndGetContext(actor, {
      type: 'PROMPT_MARKS_LOADED',
      paneId: PANE,
      historySize: 100,
      prompts: [40, 80, 103],
    });
    expect(ctx.copyModeStates[PANE].promptRows).toEqual([40, 80, 103]);
  });

  it('rows read at another history size are placed in the view’s own rows', () => {
    const { actor } = mount();
    sendAndGetContext(actor, { type: 'ENTER_SCROLL_MODE', paneId: PANE });
    // tmux answered when the history was two rows longer than the view holds.
    const marked = sendAndGetContext(actor, {
      type: 'PROMPT_MARKS_LOADED',
      paneId: PANE,
      historySize: 102,
      prompts: [42, 82],
    });
    expect(marked.copyModeStates[PANE].promptRows).toEqual([40, 80]);

    // The chunk then says the history is 102 rows: the marks move with the rows.
    const loaded = sendAndGetContext(actor, {
      type: 'COPY_MODE_CHUNK_LOADED',
      paneId: PANE,
      cells: [],
      start: 0,
      end: -1,
      historySize: 102,
      width: 80,
    });
    expect(loaded.copyModeStates[PANE].promptRows).toEqual([42, 82]);
  });

  it('a jump from the live screen asks tmux, then opens the scroll view at the prompt', () => {
    const { actor, asked } = mount();
    const before = sendAndGetContext(actor, { type: 'PROMPT_JUMP', direction: 'previous' });
    expect(before.copyModeStates[PANE]).toBeUndefined();
    expect(asked('FETCH_PROMPT_MARKS')).toEqual([
      { type: 'FETCH_PROMPT_MARKS', paneId: PANE, jump: 'previous' },
    ]);

    const ctx = sendAndGetContext(actor, {
      type: 'PROMPT_MARKS_LOADED',
      paneId: PANE,
      historySize: 100,
      prompts: [40, 80, 103],
      jump: 'previous',
    });
    const view = ctx.copyModeStates[PANE];
    expect(view.mode).toBe('scroll');
    expect(view.scrollTop).toBe(80);
    expect(view.promptRows).toEqual([40, 80, 103]);
    expect(asked('FETCH_SCROLLBACK_CELLS')).toHaveLength(1);
    expect(asked('FETCH_PROMPT_MARKS')).toHaveLength(1);
  });

  it('a jump with no prompt above opens nothing and says so', () => {
    const { actor } = mount();
    sendAndGetContext(actor, { type: 'PROMPT_JUMP', paneId: PANE, direction: 'previous' });
    const ctx = sendAndGetContext(actor, {
      type: 'PROMPT_MARKS_LOADED',
      paneId: PANE,
      historySize: 100,
      prompts: [],
      jump: 'previous',
    });
    expect(ctx.copyModeStates[PANE]).toBeUndefined();
  });

  it('a full-screen application has no scrollback to open', () => {
    const { actor } = mount(makePane(PANE, { alternateOn: true }));
    const ctx = sendAndGetContext(actor, {
      type: 'PROMPT_MARKS_LOADED',
      paneId: PANE,
      historySize: 100,
      prompts: [40],
      jump: 'previous',
    });
    expect(ctx.copyModeStates[PANE]).toBeUndefined();
  });

  it('an open view moves prompt by prompt, and the last step down is the live screen', () => {
    const { actor, asked } = mount();
    sendAndGetContext(actor, { type: 'ENTER_SCROLL_MODE', paneId: PANE });
    sendAndGetContext(actor, {
      type: 'PROMPT_MARKS_LOADED',
      paneId: PANE,
      historySize: 100,
      prompts: [40, 80, 103],
    });
    const jump = (direction: 'previous' | 'next') =>
      sendAndGetContext(actor, { type: 'PROMPT_JUMP', paneId: PANE, direction });

    expect(jump('previous').copyModeStates[PANE].scrollTop).toBe(80);
    expect(jump('previous').copyModeStates[PANE].scrollTop).toBe(40);
    expect(jump('previous').copyModeStates[PANE].scrollTop).toBe(40);
    expect(jump('next').copyModeStates[PANE].scrollTop).toBe(80);
    expect(jump('next').copyModeStates[PANE]).toBeUndefined();
    expect(asked('FETCH_PROMPT_MARKS')).toHaveLength(1);
  });

  it('copy last output is asked of the pane the menu was opened on, or the active one', () => {
    const { actor, asked } = mount();
    sendAndGetContext(actor, { type: 'COPY_LAST_OUTPUT' });
    sendAndGetContext(actor, { type: 'COPY_LAST_OUTPUT', paneId: pid('%7') });
    expect(asked('COPY_LAST_OUTPUT')).toEqual([
      { type: 'COPY_LAST_OUTPUT', paneId: PANE },
      { type: 'COPY_LAST_OUTPUT', paneId: pid('%7') },
    ]);
  });
});
