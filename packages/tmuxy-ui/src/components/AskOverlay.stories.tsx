/**
 * AskOverlay stories, over a recording of real tmux.
 *
 * `tmuxy pane send -t %3 'npm test' Enter`, run from one pane, hangs a
 * question on ANOTHER pane instead of sending the keys: the target blurs its
 * content and asks. The recording (`fixtures/scenarios/ask-and-offer.ts`)
 * hangs it the way the CLI does — `set-option -p -t %0 @tmuxy-ask <base64>`
 * — and holds the pane before and after the app's answer took it down, so
 * the chain under test is tmux option → model → overlay → answer → option
 * cleared.
 *
 * The round trip from a real `tmuxy pane send` — Cmd+Enter, a click, a long
 * multi-line send — is tests/13-send-permission.test.js, end to end.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture, type FixtureAdapter } from '../stories/fixtures/FixtureAdapter';
import ask from '../stories/fixtures/gen/ask-and-offer.json';

let adapter: FixtureAdapter | null = null;
const keepAdapter = (a: FixtureAdapter) => {
  adapter = a;
};

/** The app's answer (or dismissal) withdraws the option first. */
const answered = (to: string) => [{ match: /^set-option -pu -t %0 @tmuxy-ask\b/, to }];

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/AskOverlay',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
  args: { fixture: asFixture(ask), onAdapterReady: keepAdapter },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

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

const selected = () =>
  document.querySelector('[data-pane-ask="%0"]')?.getAttribute('data-ask-selected');

/** The answer the waiting `tmuxy pane send` reads back, from the last command sent. */
const lastAnswer = () => {
  const answers = adapter!.commands.filter((c) => c.includes('@tmuxy-ask-answer'));
  return answers[answers.length - 1]?.match(/@tmuxy-ask-answer '([^']*)'/)?.[1];
};

// ---------------------------------------------------------------------------
// Answering from the keyboard, on the pane holding it
// ---------------------------------------------------------------------------

export const KeyboardMovesBetweenYesAndNo: Story = {
  args: { start: 'asked', transitions: answered('answered') },
  parameters: {
    docs: {
      description: {
        story:
          'A pane showing a question is not a terminal to type into: the text sits on a blurred scrim with two stacked, numbered answers, Yes highlighted; ↓/↑ (or 2/1) move the highlight, Escape declines and Enter takes it, and none of those keys reach the shell underneath.',
      },
    },
  },
  play: async () => {
    const overlay = await waitForOverlay('%0');
    const question = overlay.querySelector('.ask-overlay-question') as HTMLElement;
    // The Enter that runs the line is not shown; the command sits inline.
    expect(question.textContent).toBe('claude wants to send rm -rf dist.Allow?');
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
    expect(selected()).toBe('yes');

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(selected()).toBe('no'));
    // The highlight is drawn, not just recorded.
    const no = document.querySelector(`[data-ask-choice="no"]`) as HTMLElement;
    expect(no.className).toContain('ask-overlay-choice-selected');
    await user.keyboard('1');
    await waitFor(() => expect(selected()).toBe('yes'));

    // Escape is No, whatever is highlighted.
    await user.keyboard('{Escape}');
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-3:no');

    // Asked again; Enter takes the highlight.
    adapter!.goTo('asked');
    await waitForOverlay('%0');
    await user.keyboard('{Enter}');
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-3:yes');

    // Not one of those keys was typed into the shell.
    expect(adapter!.commands.filter((c) => c.startsWith('send-keys'))).toEqual([]);
  },
};

// ---------------------------------------------------------------------------
// A restore's offer: a one-line banner, not a modal
// ---------------------------------------------------------------------------

const banner = () => document.querySelector('[data-pane-offer="%0"]') as HTMLElement | null;

export const RestoreOfferIsABannerAnyKeyDismisses: Story = {
  args: { start: 'offered', transitions: answered('offer-dismissed') },
  parameters: {
    docs: {
      description: {
        story:
          'A command a restore offers sits in one row along the bottom of its pane: the pane stays readable and its cursor stays lit. Escape drops it, and so does any other key — which then goes on to the shell, because the user has started doing something else.',
      },
    },
  },
  play: async () => {
    const shown = await waitFor(
      () => {
        if (!banner()) throw new Error('no banner yet');
        return banner()!;
      },
      { timeout: 8000, interval: 100 },
    );
    expect(shown.textContent).toBe('↵ to run:claude --resume abc123· esc to dismiss');
    // One row, at the bottom of the pane, over nothing but that row.
    const pane = document.querySelector('[data-pane-id="%0"]')!.getBoundingClientRect();
    const box = shown.getBoundingClientRect();
    expect(box.height).toBeLessThan(40);
    expect(Math.abs(box.bottom - pane.bottom)).toBeLessThan(6);
    // No question overlay: an offer blurs nothing.
    expect(document.querySelector('[data-pane-ask="%0"]')).toBeNull();

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(banner()).toBeNull(), { timeout: 8000, interval: 100 });
    // Dismissed, not run.
    expect(adapter!.commands.some((c) => c.includes('claude --resume'))).toBe(false);

    // A second offer; typing something else drops it too, and the key goes on.
    adapter!.goTo('offered-htop');
    await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 8000, interval: 100 });
    const sentBefore = adapter!.commands.length;
    await user.keyboard('l');
    await waitFor(() => expect(banner()).toBeNull(), { timeout: 8000, interval: 100 });
    expect(adapter!.commands.slice(sentBefore)).toContain("send-keys -t %0 -l -- 'l'");
  },
};
