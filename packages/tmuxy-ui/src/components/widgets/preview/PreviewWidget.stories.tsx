/**
 * The `preview` widget on the demo engine, driven the way a user drives it:
 * a file written from a shell, `tmuxy open` on it, the file edited from the
 * other pane while the preview follows, and Ctrl+C back to the shell.
 *
 * The demo's panes share one disk (`demoFiles.ts`), and its `tmuxy open`
 * reads it under the server's rules (`demoPreview.ts`). A page cannot be
 * looked into from here — it runs in a sandboxed frame with an opaque origin,
 * which is the point — so for a page the stories check what reaches the
 * frame and what the page reports back over the bridge.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AppHarness } from '../../../stories/StoryHarness';
import { pasteLine, paneGroups } from '../../../stories/appStoryHelpers';
import { channels } from '../../../stories/colorChannels';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Preview Widget',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
  args: { height: 560, initCommands: ['split-window -h'] },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

/** A `printf` that writes `text` to `file`; `\n` and `%` spelled for printf. */
function writeFile(file: string, text: string): string {
  const escaped = text.replace(/%/g, '%%').replace(/\n/g, '\\n');
  return `printf '${escaped}' > ${file}`;
}

const pane = (id: string) =>
  document.querySelector(`.pane-wrapper[data-pane-id="${id}"]`) as HTMLElement | null;

const prompts = (id: string) => (pane(id)?.textContent ?? '').split('demo@tmuxy:').length;

/**
 * Run `line` in pane `id` (the active one) and wait for its prompt to come
 * back: the shell takes no input while a command runs, so the next line
 * would be lost.
 */
async function run(id: string, line: string) {
  const before = prompts(id);
  pasteLine(line);
  await waitFor(() => expect(prompts(id)).toBeGreaterThan(before), { timeout: 15000 });
}

/** Click into a pane and wait until it is the one with the keyboard. */
async function focusPane(user: ReturnType<typeof userEvent.setup>, id: string) {
  await waitFor(() => expect(pane(id)).not.toBeNull(), { timeout: 15000 });
  await user.click(pane(id)!);
  await waitFor(() =>
    expect(pane(id)!.classList.contains('pane-active') || isActive(id)).toBe(true),
  );
}

function isActive(id: string): boolean {
  const app = (
    window as unknown as { app: { getSnapshot(): { context: { activePaneId: string } } } }
  ).app;
  return app.getSnapshot().context.activePaneId === id;
}

/** The pane on screen and `el` inside it, both with a real box. */
function expectVisibleIn(el: Element | null, container: Element | null) {
  expect(el).not.toBeNull();
  expect(container).not.toBeNull();
  const box = el!.getBoundingClientRect();
  const frame = container!.getBoundingClientRect();
  expect(box.height).toBeGreaterThan(0);
  expect(box.width).toBeGreaterThan(0);
  expect(box.top).toBeGreaterThanOrEqual(frame.top - 1);
  expect(box.top).toBeLessThan(frame.bottom);
}

async function waitForShells(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
    timeout: 30000,
  });
}

const NOTES = [
  '# Preview Title',
  '',
  'Some *text* to select.',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B[Finish]',
  '```',
  '',
].join('\n');

export const MarkdownWithMermaid: Story = {
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    await waitForShells(canvasElement);
    await focusPane(user, '%0');
    await run('%0', writeFile('notes.md', NOTES));
    pasteLine('tmuxy open notes.md');

    // The document is drawn in the pane, in the theme's colours.
    await waitFor(
      () => {
        const heading = pane('%0')?.querySelector('.preview-markdown h1') ?? null;
        expect(heading?.textContent).toBe('Preview Title');
        expectVisibleIn(heading, pane('%0'));
      },
      { timeout: 20000 },
    );
    const heading = pane('%0')!.querySelector('.preview-markdown h1')!;
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--text-primary');
    expect(channels(getComputedStyle(heading).color)).toEqual(channels(primary));
    // The pane is named after the file.
    expect(pane('%0')!.querySelector('.pane-header')?.textContent).toContain('notes.md');

    // The mermaid fence is a diagram, with its labels.
    await waitFor(
      () => {
        const svg = pane('%0')!.querySelector('.preview-mermaid svg');
        expectVisibleIn(svg, pane('%0'));
        expect(svg!.textContent).toContain('Start');
      },
      { timeout: 20000 },
    );

    // The text is the page's to select, natively.
    const paragraph = pane('%0')!.querySelector('.preview-markdown p')!;
    expect(getComputedStyle(paragraph).userSelect).toBe('text');
    await user.pointer([
      { keys: '[MouseLeft>]', target: paragraph, offset: 0 },
      { target: paragraph, offset: 4 },
      { keys: '[/MouseLeft]' },
    ]);
    expect(window.getSelection()?.toString()).toBe('Some');
  },
};

export const FollowsTheFileAndKeepsItsPlace: Story = {
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    await waitForShells(canvasElement);
    const body = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join('\n\n');
    await focusPane(user, '%0');
    await run('%0', writeFile('long.md', `# First\n\n${body}\n`));
    pasteLine('tmuxy open long.md');
    const scroller = () => pane('%0')?.querySelector('.preview-markdown') as HTMLElement | null;
    await waitFor(() => expect(scroller()?.querySelector('h1')?.textContent).toBe('First'), {
      timeout: 20000,
    });

    // Read down the document with the pager keys.
    await focusPane(user, '%0');
    await user.keyboard('jjjjjjjjjj');
    await waitFor(() => expect(scroller()!.scrollTop).toBeGreaterThan(100));
    const readTo = scroller()!.scrollTop;

    // The file changes from the other pane; the preview follows it and stays put.
    await focusPane(user, '%1');
    await run('%1', writeFile('long.md', `# Second\n\n${body}\n`));
    await waitFor(() => expect(scroller()?.querySelector('h1')?.textContent).toBe('Second'), {
      timeout: 20000,
    });
    expect(Math.abs(scroller()!.scrollTop - readTo)).toBeLessThanOrEqual(2);
  },
};

const PAGE = [
  '<!doctype html>',
  '<html><head><title>Hello Page</title>',
  '<link rel="stylesheet" href="css/page.css">',
  '</head><body><h1>Hello</h1><img src="https://tracker.example/pixel.png"></body></html>',
].join('\n');

export const HtmlPageInASandboxedFrame: Story = {
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    await waitForShells(canvasElement);
    await focusPane(user, '%0');
    await run('%0', 'mkdir -p site/css');
    await run('%0', writeFile('site/css/page.css', 'h1 { letter-spacing: 3px; }\n'));
    await run('%0', writeFile('site/index.html', PAGE));
    pasteLine('tmuxy open site/index.html');

    const frame = () =>
      pane('%0')?.querySelector('iframe.preview-frame') as HTMLIFrameElement | null;
    await waitFor(() => expectVisibleIn(frame(), pane('%0')), { timeout: 20000 });
    // An opaque origin of its own: scripts, and nothing else.
    expect(frame()!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame()!.contentDocument).toBeNull();
    // The page ran, bridge and all: it reported its own title.
    await waitFor(() => expect(frame()!.title).toBe('Hello Page'), { timeout: 20000 });

    // What the frame was given: the stylesheet beside the page inlined, the
    // theme first, and the remote image left for the offline policy to refuse.
    const composed = await (await fetch(frame()!.src)).text();
    expect(composed).toContain('letter-spacing: 3px');
    expect(composed).not.toContain('href="css/page.css"');
    expect(composed).toContain('data-tmuxy-theme');
    expect(composed).toContain('https://tracker.example/pixel.png');
  },
};

export const CtrlCReturnsToTheShell: Story = {
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    await waitForShells(canvasElement);
    await focusPane(user, '%0');
    await run('%0', writeFile('quit.md', '# Quit me\n'));
    pasteLine('tmuxy open quit.md');
    await waitFor(
      () => expect(pane('%0')?.querySelector('.preview-markdown h1')?.textContent).toBe('Quit me'),
      { timeout: 20000 },
    );

    await focusPane(user, '%0');
    await user.keyboard('{Control>}c{/Control}');
    await waitFor(() => expect(pane('%0')?.querySelector('.preview')).toBeNull(), {
      timeout: 15000,
    });
    pasteLine('echo BACK_AT_THE_SHELL');
    await waitFor(() => expect(pane('%0')?.textContent).toContain('BACK_AT_THE_SHELL'), {
      timeout: 15000,
    });
  },
};
