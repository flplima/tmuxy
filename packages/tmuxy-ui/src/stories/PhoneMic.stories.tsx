/**
 * The phone's mic key (components/phone/KeyRow.tsx, infra/dictation.ts): a tap
 * listens, the key lit while it does, and what was heard is typed into the
 * active pane as the phone keyboard types. No headless browser has a
 * microphone or a recogniser, so the story stands one in that hears what it
 * is told — the browser's Web Speech API, as Chrome and Safari carry it.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture, type FixtureAdapter } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx } from './phoneStoryHelpers';
import { activePaneId } from './appStoryHelpers';

/** The adapter of the story on screen, to read what the app sent. */
let adapter: FixtureAdapter | null = null;

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Mic',
  component: FixtureApp,
  args: {
    fixture: asFixture(phoneTwoTabs),
    start: 'main-active',
    config: { phoneLayout: true },
  },
  render: ({ fixture, start, config }) => (
    <FixtureProvider
      fixture={fixture}
      start={start}
      config={config}
      width={390}
      height={844}
      onAdapterReady={(a) => {
        adapter = a;
      }}
    >
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/** A recogniser that hears what the story says, as the browser's would. */
class StandInRecognition {
  static last: StandInRecognition | null = null;
  lang = '';
  continuous = true;
  interimResults = true;
  maxAlternatives = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    StandInRecognition.last = this;
  }
  start() {}
  stop() {
    this.onend?.();
  }
  say(transcript: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript } }] });
    this.onend?.();
  }
  refuse(error: string) {
    this.onerror?.({ error });
    this.onend?.();
  }
}

export const MicTypesWhatItHears: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'The last key on the second row is a microphone. A tap starts the browser’s speech recognition and lights the key; once the speaker pauses, the words go to the active pane as typed text and the key goes dark. A microphone the site may not use says so in a notice.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    // Both names: Chrome now carries the unprefixed one too.
    const w = window as unknown as Record<string, unknown>;
    const names = ['SpeechRecognition', 'webkitSpeechRecognition'];
    const own = names.map((n) => Object.getOwnPropertyDescriptor(window, n));
    for (const n of names) {
      Object.defineProperty(w, n, {
        value: StandInRecognition,
        configurable: true,
        writable: true,
      });
    }
    try {
      await waitFor(
        () => {
          expect(ctx().phoneLayout).toBe(true);
          expect(canvasElement.querySelector('.phone-pty .terminal-cursor')).not.toBeNull();
          expect(adapter).not.toBeNull();
        },
        { timeout: 8000 },
      );
      const mic = within(canvasElement).getByRole('button', { name: 'Dictate' });
      const micBox = box(mic);
      expect(micBox.width).toBeGreaterThan(0);
      expect(micBox.bottom).toBeLessThanOrEqual(844);
      expect(mic.getAttribute('aria-pressed')).toBe('false');

      // A tap: listening, and lit in the accent like a latched key.
      await userEvent.click(mic);
      await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
      expect(mic.classList.contains('is-latched')).toBe(true);
      expect(StandInRecognition.last!.lang).not.toBe('');

      // What it hears is typed into the active pane, and the key goes dark.
      const before = adapter!.commands.length;
      StandInRecognition.last!.say('echo hello from the mic');
      const pane = activePaneId();
      await waitFor(() => {
        const sent = adapter!.commands.slice(before);
        expect(sent).toContain(`send-keys -t ${pane} -l -- 'echo hello from the mic'`);
        expect(mic.getAttribute('aria-pressed')).toBe('false');
      });

      // The microphone refused: the notice says why, and the key is dark.
      await userEvent.click(mic);
      StandInRecognition.last!.refuse('not-allowed');
      const notice = await within(canvasElement).findByText(
        'Dictation needs the microphone: allow it for this site',
      );
      expect(box(notice).height).toBeGreaterThan(0);
      expect(mic.getAttribute('aria-pressed')).toBe('false');
    } finally {
      names.forEach((n, i) => {
        delete w[n];
        if (own[i]) Object.defineProperty(w, n, own[i]);
      });
      StandInRecognition.last = null;
    }
  },
};
