/**
 * The `diff` widget against a scripted transport: what it asks for (the pane
 * and the scope, never a path), and that what the checkout holds reaches the
 * screen as text.
 */

import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiffWidget } from '../DiffWidget';
import { AppActorContext, AppRuntimeContext } from '../../../../machines/appContexts';
import { startApp } from '../../../../test/app';
import { fakeTransport } from '../../../../test/transport';
import { pid } from '../../../../test/wire';
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

function mount({ phone = false }: { phone?: boolean } = {}) {
  const asked: BackendCall[] = [];
  const transport = fakeTransport({
    send: async (call) => {
      asked.push(call);
      const { scope } = call.args as { scope: DiffRead['scope'] };
      return read(scope);
    },
  });
  const actor = startApp({ context: { phoneLayout: phone } });
  render(
    <AppActorContext.Provider value={actor}>
      <AppRuntimeContext.Provider value={transport.runtime}>
        <DiffWidget paneId={PANE} lines={['app']} />
      </AppRuntimeContext.Provider>
    </AppActorContext.Provider>,
  );
  const diffCalls = () => asked.filter((call) => call.cmd === 'read_diff');
  return { diffCalls };
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
    const header = await screen.findByRole('button', { name: /src\/a\.rs/ });
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
});
