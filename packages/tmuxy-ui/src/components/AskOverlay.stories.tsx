/**
 * AskOverlay stories (demo engine).
 *
 * `tmuxy ask %3 npm test Enter`, run from one pane, hangs a question on
 * ANOTHER pane instead of sending the keys: the target blurs its content and
 * asks. These stories drive that through the option the CLI actually writes
 * (`set-option -p -t %id @tmuxy-ask <base64>`) rather than through a prop, so
 * the whole chain — tmux option → list-panes → model → overlay → answer →
 * option cleared — is what is under test.
 *
 * The answer the waiting CLI reads (`@tmuxy-ask-answer`) has no reader here:
 * the demo runs no shell process. What these assert is the half the user sees.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/AskOverlay',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface AppSnap {
  context: {
    activePaneId: string | null;
    activeWindowId: string | null;
    panes: Array<{ tmuxId: string; windowId: string; paneAsk?: string | null }>;
    windows: Array<{ id: string; windowType: string | null }>;
  };
}
const win = () =>
  window as unknown as { app: { getSnapshot(): AppSnap; send(event: unknown): void } };
const app = () => win().app.getSnapshot();

/** The panes of the tab in front of the user, in layout order. */
function tabPanes() {
  const { activeWindowId, panes } = app().context;
  return panes.filter((p) => p.windowId === activeWindowId);
}

/** Encode a question the way `bin/tmuxy/ask` does. */
function encodeAsk(token: string, question: string, description = ''): string {
  const json = JSON.stringify({ token, question, description });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

/** What `tmuxy ask` runs before it blocks waiting for an answer. */
function askPane(paneId: string, token: string, question: string, description = ''): void {
  win().app.send({
    type: 'SEND_TMUX_COMMAND',
    command: `set-option -p -t ${paneId} @tmuxy-ask ${encodeAsk(token, question, description)}`,
  });
}

/** The overlay drawn over a pane, once it is really on screen. */
async function waitForOverlay(paneId: string): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector(`[data-pane-ask="${paneId}"]`) as HTMLElement | null;
      if (!el) throw new Error(`no overlay on ${paneId} yet`);
      const box = el.getBoundingClientRect();
      // In the DOM is not on screen: a pane collapsed to a single row would
      // hold an overlay nobody can read or click.
      if (box.width < 40 || box.height < 20) throw new Error(`overlay on ${paneId} is not visible`);
      return el;
    },
    { timeout: 8000, interval: 100 },
  );
}

async function waitForNoOverlay(paneId: string): Promise<void> {
  await waitFor(
    () => {
      expect(document.querySelector(`[data-pane-ask="${paneId}"]`)).toBeNull();
    },
    { timeout: 8000, interval: 100 },
  );
}

// ---------------------------------------------------------------------------
// A question asked of another pane, answered with the mouse
// ---------------------------------------------------------------------------

export const AskAnotherPaneAndClickYes: Story = {
  args: { initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          'The whole round trip in one pass: a question is hung on the second pane, it blurs its content and draws the question with its description, and clicking Yes takes the overlay down and clears the option — which is what the waiting `tmuxy ask` reads before it sends the keys.',
      },
    },
  },
  play: async () => {
    const [, target] = tabPanes().map((p) => p.tmuxId);
    expect(target).toBeTruthy();

    askPane(
      target,
      'tok-1',
      'Do you want to send keys "npm test Enter"?',
      'Runs the unit suite in packages/tmuxy-ui.',
    );

    const overlay = await waitForOverlay(target);
    const body = within(overlay);
    expect(body.getByText('Do you want to send keys "npm test Enter"?')).toBeTruthy();
    // The description is the smaller second line, and it really renders.
    const description = overlay.querySelector('.ask-overlay-description') as HTMLElement;
    expect(description.textContent).toBe('Runs the unit suite in packages/tmuxy-ui.');
    expect(description.getBoundingClientRect().height).toBeGreaterThan(0);

    // The pane behind it is blurred rather than emptied: the text is still
    // there, under a scrim, which is what makes the question read as modal.
    const scrim = overlay.querySelector('.ask-overlay-scrim') as HTMLElement;
    expect(getComputedStyle(scrim).backdropFilter).toContain('blur');

    // Yes is highlighted before anything is touched — the same answer the
    // keyboard shortcut gives, so the two never disagree.
    expect(overlay.getAttribute('data-ask-selected')).toBe('yes');

    const user = userEvent.setup({ delay: 5 });
    await user.click(overlay.querySelector('[data-ask-choice="yes"]') as HTMLElement);

    await waitForNoOverlay(target);
    // The option is gone from the model too, not just from the screen.
    await waitFor(() => {
      const pane = app().context.panes.find((p) => p.tmuxId === target);
      expect(pane?.paneAsk ?? null).toBeNull();
    });
  },
};

// ---------------------------------------------------------------------------
// The shortcut the feature exists for: agree without leaving your own pane
// ---------------------------------------------------------------------------

export const CmdEnterAnswersTheWholeTab: Story = {
  args: { initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          'The real use case: an agent in the pane you are reading asks the pane beside it to run something. You never leave the agent’s pane — Cmd+Enter (Ctrl+Enter off macOS) says yes to every question pending in the tab in view.',
      },
    },
  },
  play: async () => {
    // The pane holding the keyboard is the agent's; the question goes to the
    // other one, which is the shape of the real use case.
    const here = app().context.activePaneId!;
    const there = tabPanes().find((p) => p.tmuxId !== here)!.tmuxId;
    expect(there).toBeTruthy();

    askPane(there, 'tok-2', 'Run the migration?');
    await waitForOverlay(there);

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    await waitForNoOverlay(there);
    // And the keyboard never moved.
    expect(app().context.activePaneId).toBe(here);
  },
};

// ---------------------------------------------------------------------------
// Answering from the keyboard, on the pane holding it
// ---------------------------------------------------------------------------

export const KeyboardMovesBetweenYesAndNo: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          'A pane showing a question is not a terminal to type into: while the overlay is up the arrows move the highlight and Enter takes it, and none of those keys reach the shell underneath.',
      },
    },
  },
  play: async () => {
    const target = app().context.activePaneId!;
    askPane(target, 'tok-3', 'Delete the build output?');
    const overlay = await waitForOverlay(target);

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(
        document.querySelector(`[data-pane-ask="${target}"]`)?.getAttribute('data-ask-selected'),
      ).toBe('no');
    });
    // The highlight is drawn, not just recorded.
    const no = document.querySelector(`[data-ask-choice="no"]`) as HTMLElement;
    expect(no.className).toContain('ask-overlay-choice-selected');

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(
        document.querySelector(`[data-pane-ask="${target}"]`)?.getAttribute('data-ask-selected'),
      ).toBe('yes');
    });

    expect(overlay.isConnected).toBe(true);
    await user.keyboard('{Enter}');
    await waitForNoOverlay(target);
  },
};

// ---------------------------------------------------------------------------
// Declining
// ---------------------------------------------------------------------------

export const EscapeDeclines: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          'Escape is No. The question comes down either way — what differs is what the waiting `tmuxy ask` reads back, and on no it sends nothing and exits 1.',
      },
    },
  },
  play: async () => {
    const target = app().context.activePaneId!;
    askPane(target, 'tok-4', 'Force-push to main?');
    await waitForOverlay(target);

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Escape}');
    await waitForNoOverlay(target);
  },
};
