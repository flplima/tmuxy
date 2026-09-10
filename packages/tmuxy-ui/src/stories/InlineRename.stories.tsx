/**
 * Renaming a tab or a pane where it is (demo engine).
 *
 * Both used to hand you tmux's command prompt at the bottom of the window,
 * which asks you to type a new name a long way from the thing being named.
 * The label turns into a field instead, holding what it already says with the
 * text selected, so typing replaces it and Enter is the only key you need.
 *
 * Committing on blur rather than discarding is deliberate: clicking away is
 * what people do when they think they are finished.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Inline Rename',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'A tab and a pane are renamed in place, in a field that takes the label’s position.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface Snap {
  context: {
    windows: Array<{ id: string; name: string; windowType: string | null }>;
    panes: Array<{ tmuxId: string; title: string }>;
  };
}

function app(): Snap {
  const a = (window as unknown as { app?: { getSnapshot(): Snap } }).app;
  if (!a) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return a.getSnapshot();
}

function field(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-testid="inline-rename"]');
}

/** Open a context menu on `el` and click the item whose text matches. */
async function menuAction(el: HTMLElement, label: RegExp): Promise<void> {
  await userEvent.pointer({ keys: '[MouseRight]', target: el });
  const body = within(document.body);
  await userEvent.click(await body.findByRole('menuitem', { name: label }));
}

// ---------------------------------------------------------------------------
// A tab, renamed in its own button
// ---------------------------------------------------------------------------

export const RenameATabInItsButton: Story = {
  args: {
    height: 460,
    initCommands: ['rename-window alpha', 'new-window', 'rename-window bravo'],
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'Rename Tab in the tab’s own context menu turns that tab’s label into a field, sitting where the label was, with the current name selected. Enter commits it and the strip shows the new name; Escape leaves the old one alone.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(2),
    );

    const tab = [...canvasElement.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')].find(
      (t) => t.textContent?.includes('alpha'),
    )!;
    const before = tab.getBoundingClientRect();

    await menuAction(tab, /rename tab/i);

    const input = await waitFor(() => {
      const el = field();
      expect(el, 'no rename field appeared').not.toBeNull();
      return el!;
    });
    // It is IN the tab, not at the bottom of the window.
    expect(tab.contains(input)).toBe(true);
    const box = input.getBoundingClientRect();
    expect(Math.abs(box.top - before.top)).toBeLessThan(before.height);
    // It opens holding the current name, selected, so typing replaces it.
    expect(input.value).toBe('alpha');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('alpha'.length);

    await userEvent.keyboard('charlie{Enter}');
    await waitFor(() => {
      const names = app()
        .context.windows.filter((w) => w.windowType === 'tab')
        .map((w) => w.name);
      expect(names).toContain('charlie');
      expect(names).not.toContain('alpha');
    });
    expect(field()).toBeNull();
  },
};

// ---------------------------------------------------------------------------
// Escape puts the old name back
// ---------------------------------------------------------------------------

export const EscapeLeavesTheNameAlone: Story = {
  args: { height: 460, initCommands: ['rename-window alpha', 'new-window', 'rename-window bravo'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'Escape abandons the edit: the field goes and the tab keeps the name it had, whatever was typed into it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(2),
    );

    const tab = [...canvasElement.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')].find(
      (t) => t.textContent?.includes('bravo'),
    )!;
    await menuAction(tab, /rename tab/i);
    await waitFor(() => expect(field()).not.toBeNull());

    await userEvent.keyboard('nonsense{Escape}');
    await waitFor(() => expect(field()).toBeNull());
    expect(
      app()
        .context.windows.filter((w) => w.windowType === 'tab')
        .map((w) => w.name),
    ).toContain('bravo');
  },
};

// ---------------------------------------------------------------------------
// A pane, renamed on its own title
// ---------------------------------------------------------------------------

export const RenameAPaneOnItsTitle: Story = {
  args: { height: 460, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'The pane context menu has Rename Pane, and it edits the title in the pane’s own header rather than anywhere else. Enter sends the new title to tmux, and the header shows it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(2), {
      timeout: 8000,
    });

    const tab = canvasElement.querySelector<HTMLElement>('.pane-tab')!;
    await menuAction(tab, /rename pane/i);

    const input = await waitFor(() => {
      const el = field();
      expect(el, 'no rename field appeared').not.toBeNull();
      return el!;
    });
    // In the pane's own header, where the title is.
    expect(tab.contains(input)).toBe(true);
    expect(input.value.length).toBeGreaterThan(0);

    await userEvent.keyboard('build watch{Enter}');
    await waitFor(() => {
      expect(app().context.panes.some((p) => p.title === 'build watch')).toBe(true);
    });
    await waitFor(() =>
      expect(canvasElement.querySelector('.pane-tab-title')?.textContent).toContain('build watch'),
    );
  },
};
