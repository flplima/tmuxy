/**
 * Renaming a tab or a pane where it is, over states recorded from real tmux.
 * Blur commits rather than discards: clicking away is what people do when they
 * think they are finished.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import renameTab from './fixtures/gen/rename-tab.json';
import renamePane from './fixtures/gen/rename-pane.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Inline Rename',
  component: FixtureApp,
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
type Story = StoryObj<typeof FixtureApp>;

function field(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-testid="inline-rename"]');
}

async function menuAction(el: HTMLElement, label: RegExp): Promise<void> {
  await userEvent.pointer({ keys: '[MouseRight]', target: el });
  const body = within(document.body);
  await userEvent.click(await body.findByRole('menuitem', { name: label }));
}

function tabLabels(canvasElement: HTMLElement): HTMLElement[] {
  return [...canvasElement.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')];
}

function shownTabNames(canvasElement: HTMLElement): string[] {
  return [...canvasElement.querySelectorAll<HTMLElement>('.tab-name-label')]
    .filter((t) => {
      const box = t.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((t) => t.textContent?.trim() ?? '');
}

export const RenameATabInItsButton: Story = {
  args: {
    fixture: asFixture(renameTab),
    start: 'alpha-bravo',
    transitions: [
      { match: /^rename-window -t @0 -- 'charlie'$/, to: 'charlie-bravo' },
      // What tmux would show had Escape committed the edit, so a commit on
      // Escape is on screen rather than lost on a replay.
      { match: /^rename-window -t @1 -- 'nonsense'$/, to: 'charlie-nonsense' },
    ],
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Rename Tab in the tab’s own context menu turns that tab’s label into a field, sitting where the label was, with the current name selected. Enter commits it — `rename-window -t @0`, the tab that was clicked, not the active one — and the strip shows the new name. Escape abandons the next edit: the field goes and the tab keeps the name it had, whatever was typed into it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() => expect(tabLabels(canvasElement).length).toBe(2));

    const tab = tabLabels(canvasElement).find((t) => t.textContent?.includes('alpha'))!;
    const before = tab.getBoundingClientRect();

    await menuAction(tab, /rename tab/i);

    const input = await waitFor(() => {
      const el = field();
      expect(el, 'no rename field appeared').not.toBeNull();
      return el!;
    });
    expect(tab.contains(input)).toBe(true);
    const box = input.getBoundingClientRect();
    expect(Math.abs(box.top - before.top)).toBeLessThan(before.height);
    expect(input.value).toBe('alpha');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('alpha'.length);

    await userEvent.keyboard('charlie{Enter}');
    await waitFor(() => {
      const names = shownTabNames(canvasElement);
      expect(names).toContain('charlie');
      expect(names).not.toContain('alpha');
    });
    expect(field()).toBeNull();

    const bravo = tabLabels(canvasElement).find((t) => t.textContent?.includes('bravo'))!;
    await menuAction(bravo, /rename tab/i);
    await waitFor(() => expect(field()).not.toBeNull());
    await userEvent.keyboard('nonsense{Escape}');
    await waitFor(() => expect(field()).toBeNull());
    // Long enough for a committed rename to come back from tmux.
    await new Promise((r) => setTimeout(r, 300));
    expect(shownTabNames(canvasElement)).toEqual(expect.arrayContaining(['charlie', 'bravo']));
  },
};

export const RenameAPaneOnItsTitle: Story = {
  args: {
    fixture: asFixture(renamePane),
    start: 'two',
    transitions: [{ match: /^select-pane -t %0 -T 'build watch'$/, to: 'titled' }],
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
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

    const header = canvasElement.querySelector<HTMLElement>(
      '.pane-layout-item[data-pane-id="%0"] .pane-tab',
    )!;
    await menuAction(header, /rename pane/i);

    const input = await waitFor(() => {
      const el = field();
      expect(el, 'no rename field appeared').not.toBeNull();
      return el!;
    });
    expect(header.contains(input)).toBe(true);
    expect(input.value.length).toBeGreaterThan(0);

    await userEvent.keyboard('build watch{Enter}');
    await waitFor(() => {
      const title = canvasElement.querySelector<HTMLElement>(
        '.pane-layout-item[data-pane-id="%0"] .pane-tab-title',
      );
      expect(title?.textContent).toContain('build watch');
      expect(title!.getBoundingClientRect().width).toBeGreaterThan(0);
    });
  },
};
