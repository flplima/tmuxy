import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { pasteLine, waitForBurstTail, focusFirstPane, INLINE_PNG_B64 } from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Rich Rendering',
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

/**
 * Terminal images: the guest prints a real **iTerm2 inline-image** escape
 * (`ESC ]1337;File=inline=1:<base64> BEL`). The WASM core's image parser decodes
 * the payload into the pane's image store; the Terminal renders it as an `<img>`
 * whose `src` is resolved client-side via `window.__tmuxyImageSrc` (a `data:` URL
 * straight from the Rust store — no server, no `/api/images`).
 */
export const TerminalImage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033]1337;File=inline=1:${INLINE_PNG_B64}\\a'`);
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('img[src^="data:image/png"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * OSC 52 clipboard: the guest prints an `ESC ]52;c;<base64> BEL` escape. The
 * WASM core decodes it into a `WriteClipboard` effect, the adapter forwards it to
 * its clipboard listeners, and the appMachine mirrors it into the system
 * clipboard via `navigator.clipboard.writeText`. We stub `writeText` to capture
 * the round-trip end to end.
 */
export const ClipboardOsc52: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    // Stub the SAME global navigator the appMachine reads at event time. Do this
    // AFTER the app has connected — stubbing before connect lets app init
    // re-establish navigator.clipboard and drop the stub.
    const writes: string[] = [];
    const stub = {
      writeText: (t: string) => (writes.push(t), Promise.resolve()),
      readText: () => Promise.resolve(''),
    };
    const nav = window.navigator as unknown as {
      clipboard?: { writeText?: (t: string) => Promise<void> };
    };
    try {
      Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: stub });
    } catch {
      if (nav.clipboard) nav.clipboard.writeText = stub.writeText;
    }
    // base64('HELLO_CLIP') === 'SEVMTE9fQ0xJUA=='
    pasteLine("printf '\\033]52;c;SEVMTE9fQ0xJUA==\\a'");
    await waitFor(() => expect(writes).toContain('HELLO_CLIP'), { timeout: 40000, interval: 500 });
  },
};

/**
 * Kitty graphics protocol: the guest emits a Kitty APC transmit+display escape
 * with a PNG payload; the WASM core's Kitty parser decodes it into the pane's
 * image store and the Terminal renders an `<img>` — a different protocol path
 * than the iTerm2 story.
 */
export const KittyImage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033_Gf=100,a=T;${INLINE_PNG_B64}\\033\\\\'`);
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('img[src^="data:image/png"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Sixel: the guest emits a DCS sixel sequence; the core transcodes it to PNG
 * (icy_sixel) and the Terminal renders it — covering the third image protocol.
 */
export const SixelImage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033Pq#0;2;100;0;0#0!30~-#0!30~\\033\\\\'`);
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('img[src^="data:image/png"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * OSC 8 hyperlinks: wrapped text renders as a real anchor with the target href.
 *
 * Asserts the anchor's TEXT as well as its href. Checking only the href let a
 * real bug through — the URL was recorded against cells derived from a private
 * cursor that ignored CSI movement, so the anchor carried the right href on the
 * wrong text (the line *after* the link). An href-only assertion passes for
 * that; the label check is what pins the link to its own cells.
 */
export const Osc8Hyperlink: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033]8;;https://example.com/x8\\033\\\\LINK_TEXT_8\\033]8;;\\033\\\\\\n'`);
    await waitFor(
      () => {
        const link = canvasElement.ownerDocument.querySelector(
          'a.terminal-hyperlink',
        ) as HTMLAnchorElement | null;
        expect(link).not.toBeNull();
        expect(link!.href).toContain('example.com/x8');
        expect(link!.textContent).toBe('LINK_TEXT_8');
      },
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Image placements are content-tracked: as new lines scroll the terminal,
 * `ImageParser::shift_rows_up` shifts each placement's `row` up by the
 * vt100 scroll delta so the image scrolls with its surrounding text and leaves
 * the live viewport once scrolled past row 0 (remaining accessible in
 * scroll/copy mode until evicted past the scrollback limit).
 */
export const ImageAnchoredDuringScroll: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const doc = canvasElement.ownerDocument;
    pasteLine(`printf '\\033]1337;File=inline=1;height=2:${INLINE_PNG_B64}\\a\\n'`);
    await waitFor(
      () => {
        const img = doc.querySelector('img[src^="data:image/png"]');
        expect(img).not.toBeNull();
      },
      { timeout: 40000, interval: 500 },
    );
    pasteLine('seq 1 60');
    // Wait for the burst to scroll the 2-row image completely off the live viewport.
    await waitForBurstTail(canvas, (text) => /585960(\D|$)/.test(text.replace(/\s+/g, '')));
    const img = doc.querySelector('img[src^="data:image/png"]');
    expect(img).toBeNull();
  },
};
