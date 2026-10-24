import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Start',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

/** What the app shows: its tabs, and each pane's box. */
const frame = () =>
  [
    ...[...document.querySelectorAll('[role=tab]')]
      .filter((t) => visible(t) && /^Tab \d+:/.test(t.getAttribute('aria-label') ?? ''))
      .map((t) => t.getAttribute('aria-label')),
    ...[...document.querySelectorAll('[role=group][aria-label^="Pane %"]')]
      .filter(visible)
      .map((p) => {
        const r = p.getBoundingClientRect();
        return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      }),
  ].join(' | ');

/** Every distinct frame the app showed since the story's loader ran, before
 *  the app mounted. */
let frames: string[] = [];
let recorder: MutationObserver | null = null;
const lastFrame = () => frames[frames.length - 1];

/**
 * A start whose init does its work on a shell's time: a second tab whose
 * shell, a second later, switches back to the first tab and only then says it
 * is done. The app shows only the start it ends at: the first tab, at the
 * size its box measures (narrower than the guest starts at) — never the
 * second tab, a lone tab, or a layout of another size on the way.
 */
export const ShowsOnlyTheFinishedStart: Story = {
  args: {
    cols: 64,
    rows: 20,
    initCommands: [
      'new-window',
      'send-keys -l "sleep 1; tmux last-window; tmux set -g @tmuxy-story-ready 1"',
      'send-keys Enter',
    ],
    initDoneOption: '@tmuxy-story-ready',
  },
  loaders: [
    () => {
      frames = [];
      let pending = false;
      recorder?.disconnect();
      recorder = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          const now = frame();
          if (now && now !== lastFrame()) frames.push(now);
        });
      });
      recorder.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      return {};
    },
  ],
  play: async () => {
    await waitFor(
      () => {
        expect(lastFrame()).toMatch(/^Tab 1: \S+ \(active\) \| Tab 2: \S+ \|/);
      },
      { timeout: 60000, interval: 200 },
    );
    expect(frames).toEqual([lastFrame()]);
  },
};
