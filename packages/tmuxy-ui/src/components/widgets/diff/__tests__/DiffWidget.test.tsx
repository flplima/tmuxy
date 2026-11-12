/**
 * The `diff` widget against a scripted transport: what it asks for (the pane
 * and the scope, never a path), and that what the checkout holds reaches the
 * screen as text.
 */

import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiffWidget } from '../DiffWidget';
import { AppActorContext, AppRuntimeContext } from '../../../../machines/appContexts';
import { recorder, startApp } from '../../../../test/app';
import { fakeTransport } from '../../../../test/transport';
import { pid, wid } from '../../../../test/wire';
import { modelPane } from '../../../../test/model';
import type { BackendCall } from '../../../../domain/backendCalls';
import type { DiffRead } from '../../../../domain/diff';

const PANE = pid('%7');

function read(scope: DiffRead['scope'], over: Partial<DiffRead> = {}): DiffRead {
  return {
    name: 'app',
    scope,
    branch: 'feature',
    base: scope === 'branch' ? 'main' : null,
    files: [
      {
        path: 'src/a.rs',
        oldPath: null,
        status: 'modified',
        binary: false,
        modeChange: null,
        hunks: [
          {
            header: '@@ -1,2 +1,2 @@',
            lines: [
              { kind: 'context', old: 1, new: 1, text: 'fn main() {' },
              { kind: 'removed', old: 2, new: null, text: '}' },
              { kind: 'added', old: null, new: 2, text: '<img src=x onerror=alert(1)>' },
            ],
          },
        ],
      },
    ],
    untracked: ['notes.txt'],
    untrackedMore: 0,
    truncated: false,
    ...over,
  };
}

const WINDOW = wid('@1');

function mount({
  phone = false,
  agentState = null,
  agentCommand = 'claude',
}: { phone?: boolean; agentState?: string | null; agentCommand?: string } = {}) {
  const asked: BackendCall[] = [];
  const transport = fakeTransport({
    send: async (call) => {
      asked.push(call);
      const { scope } = call.args as { scope: DiffRead['scope'] };
      return read(scope);
    },
  });
  const tmux = recorder();
  const actor = startApp({
    context: {
      phoneLayout: phone,
      panes: [
        modelPane(pid('%3'), WINDOW, { command: agentCommand, paneState: agentState }),
        modelPane(PANE, WINDOW),
      ],
      activeWindowId: WINDOW,
    },
    actors: { tmuxStoreActor: tmux.logic },
  });
  render(
    <AppActorContext.Provider value={actor}>
      <AppRuntimeContext.Provider value={transport.runtime}>
        <DiffWidget paneId={PANE} lines={['app', 'to:%3']} />
      </AppRuntimeContext.Provider>
    </AppActorContext.Provider>,
  );
  const diffCalls = () => asked.filter((call) => call.cmd === 'read_diff');
  const ops = () => tmux.ops();
  const notices = () => actor.getSnapshot().context.notifications.map((n) => n.text);
  return { diffCalls, ops, notices };
}

/** Comment on the added line of src/a.rs, as a click and some typing would. */
async function commentOnAddedLine(body: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Comment on src/a.rs line 2' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('DiffWidget', () => {
  it('asks for the pane and the scope, and draws the changes as text', async () => {
    const { diffCalls } = mount();
    await screen.findByText('src/a.rs');
    expect(diffCalls()[0]).toEqual({ cmd: 'read_diff', args: { paneId: '%7', scope: 'unstaged' } });

    // Markup in a line is a line: shown as written, and no element made of it.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('.diff-widget img')).toBeNull();
    const added = document.querySelector('[data-diff-line="added"]')!;
    expect(added.querySelector('.diff-no-new')!.textContent).toBe('2');
    expect(added.querySelector('.diff-sign')!.textContent).toBe('+');
    expect(screen.getByText('1 file · +1 −1')).toBeTruthy();
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.getByText('feature')).toBeTruthy();
  });

  it('switches scope, and says what a branch is compared with', async () => {
    const { diffCalls } = mount();
    await screen.findByText('src/a.rs');
    fireEvent.click(screen.getByRole('tab', { name: 'Branch' }));
    await screen.findByText('feature against main');
    expect(diffCalls()[diffCalls().length - 1]).toEqual({
      cmd: 'read_diff',
      args: { paneId: '%7', scope: 'branch' },
    });
    expect(screen.getByRole('tab', { name: 'Branch' }).getAttribute('aria-selected')).toBe('true');
  });

  it('folds a file away and back', async () => {
    mount();
    await screen.findByText('src/a.rs');
    const header = document.querySelector<HTMLButtonElement>('.diff-file-header')!;
    fireEvent.click(header);
    expect(document.querySelector('[data-diff-line]')).toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(document.querySelector('[data-diff-line]')).not.toBeNull();
  });

  it('reads again on refresh', async () => {
    const { diffCalls } = mount();
    await screen.findByText('src/a.rs');
    const before = diffCalls().length;
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Read the changes again' }));
    });
    await waitFor(() => expect(diffCalls().length).toBe(before + 1));
  });

  it('takes the phone layout', async () => {
    mount({ phone: true });
    await screen.findByText('src/a.rs');
    expect(document.querySelector('.diff-widget.is-phone')).not.toBeNull();
  });

  it('keeps a comment under its line, and sends the review to the agent as one prompt', async () => {
    const { ops, notices } = mount();
    await commentOnAddedLine('Escape this.');
    const comment = document.querySelector('[data-diff-comment]')!;
    expect(comment.textContent).toContain('Escape this.');
    expect(screen.getByText('1 comment')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Send review' }));

    const sent = ops();
    expect(sent).toEqual([
      {
        _tag: 'SendReview',
        id: expect.stringMatching(/^[a-z0-9]+$/),
        target: '%3',
        text: 'Review of the unstaged changes in app:\n\n1. src/a.rs:2 — Escape this.\n   > <img src=x onerror=alert(1)>',
      },
    ]);
    expect(notices()).toContain('Sent 1 comment to %3');
    // Sent is done with: the review starts again.
    expect(document.querySelector('[data-diff-comment]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send review' })).toBeNull();
    // Were it refused by tmux, it comes back.
    fireEvent.click(screen.getByRole('button', { name: 'Restore the last review' }));
    expect(document.querySelector('[data-diff-comment]')!.textContent).toContain('Escape this.');
  });

  it('offers no shell to send to, and sends nothing', async () => {
    const { ops } = mount({ agentCommand: 'zsh' });
    await commentOnAddedLine('Escape this.');
    expect(screen.getByText('no agent in this tab')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send review' }).disabled).toBe(
      true,
    );
    expect(ops()).toEqual([]);
  });

  it('sends nothing to an agent that waits for an answer, and keeps the review', async () => {
    const { ops, notices } = mount({ agentState: 'needs-input' });
    await commentOnAddedLine('Escape this.');
    fireEvent.click(screen.getByRole('button', { name: 'Send review' }));
    expect(ops()).toEqual([]);
    expect(notices()).toContain(
      'Review not sent: %3 is waiting for your answer: answer it first, nothing was sent',
    );
    expect(document.querySelector('[data-diff-comment]')).not.toBeNull();
  });

  it('edits and deletes a comment', async () => {
    mount();
    await commentOnAddedLine('First.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'Second.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(document.querySelector('[data-diff-comment]')!.textContent).toContain('Second.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(document.querySelector('[data-diff-comment]')).toBeNull();
  });
});
