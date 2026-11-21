/**
 * The phone's compose sheet (components/phone/ComposeSheet.tsx): ⌨ on the key
 * row, held, opens the whole screen to write in with the phone keyboard's
 * corrections and suggestions; Send pastes all of it into the active pane at
 * once. Dragged down by its bar it closes without sending, and what was
 * written waits for the next time.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture, type FixtureAdapter } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx } from './phoneStoryHelpers';
import { activePaneId } from './appStoryHelpers';
import { HOLD_MS } from '../components/phone/touchGesture';

/** The adapter of the story on screen, to read what the app sent. */
let adapter: FixtureAdapter | null = null;

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Compose',
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

const sheet = () => document.querySelector('[data-testid="compose-sheet"]');

type User = ReturnType<typeof userEvent.setup>;

/**
 * Press ⌨ and keep the finger on it past a hold, then lift it. One `user`
 * for both: a fresh one would not know the button was down, and release
 * nothing.
 */
async function holdKeyboardKey(user: User, key: HTMLElement) {
  await user.pointer({ keys: '[MouseLeft>]', target: key });
  await waitFor(() => expect(sheet()).not.toBeNull(), { timeout: HOLD_MS + 2000 });
  await user.pointer({ keys: '[/MouseLeft]', target: key });
}

export const HoldKeyboardToCompose: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'Holding ⌨ on the key row opens the compose sheet over the whole screen, titled with the pane and the program running there: a text box in a size a phone does not zoom into, with the keyboard’s own autocorrect and suggestions on, that scrolls only once the text outgrows it, × to close, and Send at the bottom right, which pastes everything written into the active pane at once. Dragged down by its bar the sheet closes without sending, and the text is still there the next time.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    await waitFor(
      () => {
        expect(ctx().phoneLayout).toBe(true);
        expect(canvasElement.querySelector('.phone-pty .terminal-cursor')).not.toBeNull();
        expect(adapter).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const key = canvasElement.querySelector('[data-key-row="⌨"]') as HTMLElement;
    expect(box(key).width).toBeGreaterThan(0);

    // 1. Held, ⌨ opens the sheet, and the release gives its text box the focus.
    //    Its title is the pane Send goes to and the program running there
    //    (tmux's pane_current_command), not the pane's title.
    const pane = activePaneId();
    const program = ctx().panes.find((p) => p.tmuxId === pane)!.command;
    await holdKeyboardKey(user, key);
    const dialog = within(document.body).getByRole('dialog', {
      name: `Send to pane ${pane} - ${program}`,
    });
    const area = within(dialog).getByRole('textbox', { name: 'Text to send' });
    await waitFor(() => expect(document.activeElement).toBe(area));
    // The whole screen, and the phone keyboard's help left on.
    const shown = box(dialog);
    expect(shown.top).toBeLessThan(40);
    expect(shown.bottom).toBeGreaterThan(800);
    expect(area.getAttribute('autocorrect')).toBe('on');
    expect(area.getAttribute('spellcheck')).toBe('true');
    expect(parseFloat(getComputedStyle(area).fontSize)).toBeGreaterThanOrEqual(16);
    // × at the bar's right end; Send at the sheet's bottom right, disabled
    // until something is written.
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(box(close).right).toBeGreaterThan(shown.right - 60);
    expect(box(close).top).toBeLessThan(shown.top + 60);
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    const send = within(dialog).getByRole('button', { name: 'Send' });
    expect(box(send).right).toBeGreaterThan(shown.right - 40);
    expect(box(send).bottom).toBeGreaterThan(shown.bottom - 40);
    expect(send).toBeDisabled();

    // 2. The text box scrolls only once the text outgrows it, and a slide on
    //    it before then moves nothing.
    const slide = () => {
      const r = box(area);
      const at = new Touch({
        identifier: 7,
        target: area,
        clientX: r.left + 40,
        clientY: r.top + 80,
      });
      const move = new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [at],
        changedTouches: [at],
        targetTouches: [at],
      });
      area.dispatchEvent(move);
      return move.defaultPrevented;
    };
    expect(getComputedStyle(area).overflowY).toBe('hidden');
    expect(slide()).toBe(true);
    await user.paste(Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'));
    await waitFor(() => expect(getComputedStyle(area).overflowY).toBe('auto'));
    expect(slide()).toBe(false);
    await user.clear(area);
    await waitFor(() => expect(getComputedStyle(area).overflowY).toBe('hidden'));

    // 3. Two lines written, Send: both go to the active pane as one paste,
    //    and the sheet closes.
    await user.type(area, 'echo first{Enter}echo second');
    const before = adapter!.commands.length;
    await user.click(send);
    await waitFor(() => {
      const sent = adapter!.commands.slice(before).join('\n');
      expect(sent).toContain('echo first');
      expect(sent).toContain('echo second');
      expect(sent).toContain(`paste-buffer -p -d -b`);
      expect(sent).toContain(`-t ${pane}`);
    });
    await waitFor(() => expect(sheet()).toBeNull());

    // 4. A draft dragged away: nothing is sent, and it is there next time.
    await holdKeyboardKey(user, key);
    const again = within(document.body).getByRole('textbox', { name: 'Text to send' });
    expect((again as HTMLTextAreaElement).value).toBe('');
    await user.type(again, 'a draft');
    const bar = document.querySelector('[data-testid="compose-sheet-bar"]') as HTMLElement;
    const top = box(bar);
    const x = top.left + top.width / 2;
    const y = top.top + 4;
    const sentBefore = adapter!.commands.length;
    await user.pointer([
      { keys: '[MouseLeft>]', target: bar, coords: { clientX: x, clientY: y } },
      { target: bar, coords: { clientX: x, clientY: y + 150 } },
      { target: bar, coords: { clientX: x, clientY: y + 320 } },
      { keys: '[/MouseLeft]', target: bar, coords: { clientX: x, clientY: y + 320 } },
    ]);
    await waitFor(() => expect(sheet()).toBeNull());
    expect(adapter!.commands.slice(sentBefore).join('\n')).not.toContain('paste-buffer');

    await holdKeyboardKey(user, key);
    const kept = within(document.body).getByRole('textbox', { name: 'Text to send' });
    expect((kept as HTMLTextAreaElement).value).toBe('a draft');
    await user.click(within(document.body).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(sheet()).toBeNull());

    // 5. A tap on ⌨ is still the keyboard's toggle, not a sheet.
    await user.click(key);
    expect(sheet()).toBeNull();
  },
};
