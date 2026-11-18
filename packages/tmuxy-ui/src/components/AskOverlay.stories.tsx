/**
 * Over recordings of real tmux (`fixtures/scenarios/ask-and-offer.ts`,
 * `fixtures/scenarios/pane-question.ts`) that hang the question the way the
 * CLI does (`set-option -p -t %0 @tmuxy-ask <base64>`), so the chain under
 * test is tmux option → model → overlay → answer → option cleared. The round
 * trips from a real `tmuxy pane send` and `tmuxy pane ask` are
 * tests/13-send-permission.test.js and tests/13-pane-ask.test.js.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from '../stories/FixtureHarness';
import { asFixture, adapterHolder } from '../stories/fixtures/FixtureAdapter';
import ask from '../stories/fixtures/gen/ask-and-offer.json';
import question from '../stories/fixtures/gen/pane-question.json';
import { decodeBase64Text } from '../domain/base64';

const held = adapterHolder();

/** The app's answer (or dismissal) withdraws the option first. */
const answered = (to: string) => [{ match: /^set-option -pu -t %0 @tmuxy-ask\b/, to }];

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/AskOverlay',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
  args: { fixture: asFixture(ask), onAdapterReady: held.keep },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

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
  const answers = held.adapter!.commands.filter((c) => c.includes('@tmuxy-ask-answer'));
  return answers[answers.length - 1]?.match(/@tmuxy-ask-answer '([^']*)'/)?.[1];
};

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
    // The Enter that runs the line is not shown.
    expect(question.textContent).toBe('claude wants to send rm -rf dist.Allow?');
    expect(overlay.querySelector('.ask-overlay-command-block')).toBeNull();
    const answers = [...overlay.querySelectorAll('[data-ask-choice]')];
    expect(answers.map((a) => a.textContent)).toEqual(['1.Yes', '2.No']);
    const [yesBox, noBox] = answers.map((a) => a.getBoundingClientRect());
    expect(noBox.top).toBeGreaterThanOrEqual(yesBox.bottom);
    const text = overlay.querySelector('.ask-overlay-text') as HTMLElement;
    expect(getComputedStyle(text).borderTopWidth).toBe('0px');
    expect(getComputedStyle(text).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    const scrim = overlay.querySelector('.ask-overlay-scrim') as HTMLElement;
    expect(getComputedStyle(scrim).backdropFilter).toContain('blur');
    // Yes is highlighted before anything is touched — the same answer the
    // keyboard shortcut gives, so the two never disagree.
    expect(selected()).toBe('yes');

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(selected()).toBe('no'));
    const no = document.querySelector(`[data-ask-choice="no"]`) as HTMLElement;
    expect(no.className).toContain('ask-overlay-choice-selected');
    await user.keyboard('1');
    await waitFor(() => expect(selected()).toBe('yes'));

    // Escape is No, whatever is highlighted.
    await user.keyboard('{Escape}');
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-3:no');

    held.adapter!.goTo('asked');
    await waitForOverlay('%0');
    await user.keyboard('{Enter}');
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-3:yes');

    expect(held.adapter!.commands.filter((c) => c.startsWith('send-keys'))).toEqual([]);
  },
};

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
    const pane = document.querySelector('[data-pane-id="%0"]')!.getBoundingClientRect();
    const box = shown.getBoundingClientRect();
    expect(box.height).toBeLessThan(40);
    expect(Math.abs(box.bottom - pane.bottom)).toBeLessThan(6);
    expect(document.querySelector('[data-pane-ask="%0"]')).toBeNull();

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(banner()).toBeNull(), { timeout: 8000, interval: 100 });
    expect(held.adapter!.commands.some((c) => c.includes('claude --resume'))).toBe(false);

    held.adapter!.goTo('offered-htop');
    await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 8000, interval: 100 });
    const sentBefore = held.adapter!.commands.length;
    await user.keyboard('l');
    await waitFor(() => expect(banner()).toBeNull(), { timeout: 8000, interval: 100 });
    expect(held.adapter!.commands.slice(sentBefore)).toContain("send-keys -t %0 -l -- 'l'");
  },
};

/** Every one of `elements` lies inside pane %0's terminal area, with room to read and press. */
function insidePane(elements: Element[]) {
  const pane = document.querySelector('[data-pane-id="%0"] .pane-content')!.getBoundingClientRect();
  for (const el of elements) {
    const box = el.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(20);
    expect(box.height).toBeGreaterThan(10);
    expect(box.left).toBeGreaterThanOrEqual(pane.left - 1);
    expect(box.right).toBeLessThanOrEqual(pane.right + 1);
    expect(box.top).toBeGreaterThanOrEqual(pane.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(pane.bottom + 1);
  }
}

const sentKeys = () => held.adapter!.commands.filter((c) => c.startsWith('send-keys'));

export const QuestionWithChoices: Story = {
  args: {
    fixture: asFixture(question),
    start: 'question-choices',
    transitions: answered('question-answered'),
  },
  parameters: {
    docs: {
      description: {
        story:
          '`tmuxy pane ask "Deploy main to production?" --choice deploy --choice wait`: who asks, the question as the script wrote it (markup shows as text), and one numbered button a choice, the first highlighted. ↓/↑ or a digit move the highlight, Enter takes it, Escape dismisses, a click picks; none of those keys reach the shell underneath.',
      },
    },
  },
  play: async () => {
    const overlay = await waitForOverlay('%0');
    expect(overlay.querySelector('.ask-overlay-question')?.textContent).toBe('claude asks:');
    const prompt = overlay.querySelector('.ask-overlay-prompt') as HTMLElement;
    expect(prompt.textContent).toBe('Deploy <b>main</b> to production?');
    expect(prompt.querySelector('b')).toBeNull();
    const answers = [...overlay.querySelectorAll<HTMLElement>('[data-ask-choice]')];
    expect(answers.map((a) => a.textContent)).toEqual(['1.deploy', '2.wait']);
    const dismiss = overlay.querySelector('[data-ask-dismiss]')!;
    insidePane([prompt, ...answers, dismiss]);
    // Real buttons, reachable by Tab from the app's chrome.
    expect(answers.map((a) => a.tabIndex)).toEqual([0, 0]);
    expect(selected()).toBe('0');

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(selected()).toBe('1'));
    await user.keyboard('{Escape}');
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-q:no');

    // Enter takes the first choice, untouched.
    held.adapter!.goTo('question-choices');
    await waitForOverlay('%0');
    await user.keyboard('{Enter}');
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-q:choice:0');

    held.adapter!.goTo('question-choices');
    await waitForOverlay('%0');
    await user.click(document.querySelector('[data-pane-ask="%0"] [data-ask-choice="1"]')!);
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-q:choice:1');
    expect(sentKeys()).toEqual([]);
  },
};

export const QuestionWithATextField: Story = {
  args: {
    fixture: asFixture(question),
    start: 'question-text',
    transitions: answered('text-answered'),
  },
  parameters: {
    docs: {
      description: {
        story:
          '`tmuxy pane ask "Name the release branch" --text`: one line to type, focused while the pane holds the keyboard, and Submit. Enter submits what was typed, Escape dismisses; what is typed stays in the field and never reaches the shell.',
      },
    },
  },
  play: async () => {
    const overlay = await waitForOverlay('%0');
    const field = overlay.querySelector<HTMLInputElement>('[data-ask-text]')!;
    const submit = overlay.querySelector('[data-ask-submit]')!;
    insidePane([field, submit]);
    await waitFor(() => expect(document.activeElement).toBe(field), { timeout: 8000 });

    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('release/1.4, ação');
    expect(field.value).toBe('release/1.4, ação');
    await user.keyboard('{Enter}');
    await waitForNoOverlay('%0');
    const answer = lastAnswer()!;
    expect(answer.startsWith('tok-t:text:')).toBe(true);
    expect(decodeBase64Text(answer.slice('tok-t:text:'.length))).toBe('release/1.4, ação');

    held.adapter!.goTo('question-text');
    await waitForOverlay('%0');
    await waitFor(() => expect(document.activeElement?.matches('[data-ask-text]')).toBe(true));
    await user.keyboard('{Escape}');
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-t:no');
    expect(sentKeys()).toEqual([]);
  },
};

export const QuestionOnAPhone: Story = {
  args: {
    fixture: asFixture(question),
    start: 'question-choices',
    transitions: answered('question-answered'),
    config: { phoneLayout: true },
  },
  render: ({ fixture, start, transitions, config }) => (
    <FixtureProvider
      fixture={fixture}
      start={start}
      transitions={transitions}
      config={config}
      onAdapterReady={held.keep}
      width={390}
      height={844}
    >
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'The same question at a 390 × 844 phone’s width: the question, a row a finger can hit for each choice, and a dismiss in place of the Escape a phone has no key for.',
      },
    },
  },
  play: async () => {
    const overlay = await waitForOverlay('%0');
    const answers = [...overlay.querySelectorAll('[data-ask-choice]')];
    const dismiss = overlay.querySelector('[data-ask-dismiss]')!;
    insidePane([overlay.querySelector('.ask-overlay-prompt')!, ...answers, dismiss]);
    for (const target of [...answers, dismiss]) {
      expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
    }
    const user = userEvent.setup({ delay: 5 });
    await user.click(dismiss);
    await waitForNoOverlay('%0');
    expect(lastAnswer()).toBe('tok-q:no');
  },
};
