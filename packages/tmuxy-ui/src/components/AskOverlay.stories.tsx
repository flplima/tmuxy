/**
 * AskOverlay stories (demo engine).
 *
 * `tmuxy pane send -t %3 'npm test' Enter`, run from one pane, hangs a
 * question on ANOTHER pane instead of sending the keys: the target blurs its
 * content and asks. These stories drive that through the option the CLI actually writes
 * (`set-option -p -t %id @tmuxy-ask <base64>`) rather than through a prop, so
 * the whole chain — tmux option → list-panes → model → overlay → answer →
 * option cleared — is what is under test.
 *
 * The answer the waiting CLI reads (`@tmuxy-ask-answer`) has no reader here:
 * the demo runs no shell process. What these assert is the half the user sees.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
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

/** Encode a question the way `bin/tmuxy/send` does. */
function encodeAsk(token: string, keys: string[]): string {
  const json = JSON.stringify({ token, caller: 'claude', keys });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

/** What `tmuxy pane send -t` runs before it blocks waiting for an answer. */
function askPane(paneId: string, token: string, keys: string[]): void {
  win().app.send({
    type: 'SEND_TMUX_COMMAND',
    command: `set-option -p -t ${paneId} @tmuxy-ask ${encodeAsk(token, keys)}`,
  });
}

/** A long multi-line send: a heredoc, a test run and a commit. */
const LONG_SEND = [
  "cat > notes.md <<'EOF'",
  'Enter',
  ...Array.from({ length: 14 }, (_, i) => [
    // Twice the 70ch the text is capped at: a sideways scroll at any size.
    `line ${i + 1} of the notes ${'-'.repeat(140)}`,
    'Enter',
  ]).flat(),
  'EOF',
  'Enter',
  'npm test -- --run && git add notes.md && git commit -m "notes"',
  'Enter',
];

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
          'The whole round trip in one pass: a send is hung on the second pane, it blurs its content and asks who wants to send what, and clicking Yes takes the overlay down and clears the option — which is what the waiting `tmuxy pane send` reads before it sends the keys.',
      },
    },
  },
  play: async () => {
    const [, target] = tabPanes().map((p) => p.tmuxId);
    expect(target).toBeTruthy();

    askPane(target, 'tok-1', ['npm test', 'Enter']);

    const overlay = await waitForOverlay(target);
    const question = overlay.querySelector('.ask-overlay-question') as HTMLElement;
    // The Enter that runs the line is not shown; the command sits inline.
    expect(question.textContent).toBe('claude wants to send npm test.Allow?');
    expect(overlay.querySelector('.ask-overlay-command-block')).toBeNull();
    // Two answers, stacked and numbered.
    const answers = [...overlay.querySelectorAll('[data-ask-choice]')];
    expect(answers.map((a) => a.textContent)).toEqual(['1.Yes', '2.No']);
    const [yesBox, noBox] = answers.map((a) => a.getBoundingClientRect());
    expect(noBox.top).toBeGreaterThanOrEqual(yesBox.bottom);
    // No card: the text sits straight on the scrim.
    const text = overlay.querySelector('.ask-overlay-text') as HTMLElement;
    expect(getComputedStyle(text).borderTopWidth).toBe('0px');
    expect(getComputedStyle(text).backgroundColor).toBe('rgba(0, 0, 0, 0)');

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
// Answering from the keyboard, on the pane holding it. Cmd+Enter answering
// the pane beside you is tests/13-ask-confirmation.test.js, end to end.
// ---------------------------------------------------------------------------

export const KeyboardMovesBetweenYesAndNo: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          'A pane showing a question is not a terminal to type into: while the overlay is up ↓/↑ (or 2/1) move the highlight and Enter takes it, and none of those keys reach the shell underneath.',
      },
    },
  },
  play: async () => {
    const target = app().context.activePaneId!;
    askPane(target, 'tok-3', ['rm -rf dist', 'Enter']);
    const overlay = await waitForOverlay(target);

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(
        document.querySelector(`[data-pane-ask="${target}"]`)?.getAttribute('data-ask-selected'),
      ).toBe('no');
    });
    // The highlight is drawn, not just recorded.
    const no = document.querySelector(`[data-ask-choice="no"]`) as HTMLElement;
    expect(no.className).toContain('ask-overlay-choice-selected');

    await user.keyboard('1');
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
          'Escape is No. The question comes down either way — what differs is what the waiting `tmuxy pane send` reads back, and on no it sends nothing and exits 1.',
      },
    },
  },
  play: async () => {
    const target = app().context.activePaneId!;
    askPane(target, 'tok-4', ['git push --force', 'Enter']);
    await waitForOverlay(target);

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Escape}');
    await waitForNoOverlay(target);
  },
};

// ---------------------------------------------------------------------------
// A long, multi-line send
// ---------------------------------------------------------------------------

export const LongSendScrollsBetweenTheQuestionAndTheAnswers: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          'A multi-line send gets a block of its own between "wants to send:" and "Allow?". It is shown whole, never cut: the block scrolls on both axes while the question and the answers stay put.',
      },
    },
  },
  play: async () => {
    const target = app().context.activePaneId!;
    askPane(target, 'tok-5', LONG_SEND);
    const overlay = await waitForOverlay(target);

    const block = overlay.querySelector('.ask-overlay-command-block') as HTMLElement;
    expect(block).toBeTruthy();
    // Whole: every line is in the block, the last one included.
    expect(block.textContent).toContain('line 14 of the notes');
    expect(block.textContent).toContain('git commit -m "notes"');
    // It scrolls rather than pushing the answers off the pane.
    expect(block.scrollHeight).toBeGreaterThan(block.clientHeight);
    expect(block.scrollWidth).toBeGreaterThan(block.clientWidth);

    const paneBox = overlay.getBoundingClientRect();
    const answers = overlay.querySelector('.ask-overlay-choices') as HTMLElement;
    const [first, last] = overlay.querySelectorAll('.ask-overlay-question');
    expect(first.textContent).toBe('claude wants to send:');
    expect(last.textContent).toBe('Allow?');
    for (const el of [first, last, answers]) {
      const box = el.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(paneBox.top);
      expect(box.bottom).toBeLessThanOrEqual(paneBox.bottom);
    }

    // Scrolling the block moves neither the question nor the answers.
    const answersTop = answers.getBoundingClientRect().top;
    block.scrollTop = block.scrollHeight;
    expect(answers.getBoundingClientRect().top).toBe(answersTop);

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Escape}');
    await waitForNoOverlay(target);
  },
};
