import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { TmuxyBrowser } from './TmuxyBrowser';
import { ProviderHarness } from '../../../stories/StoryHarness';
import type { WidgetProps } from '../index';

// 1×1 opaque PNG, small enough to embed and decode instantly.
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const MARKDOWN = [
  '# Release Notes',
  '',
  'Fixed a bug in `parseLayout` and added GFM tables:',
  '',
  '| Key | Action |',
  '| --- | ------ |',
  '| C-a | prefix |',
  '',
  '```mermaid',
  'graph TD;',
  '  A[Start] --> B[End];',
  '```',
].join('\n');

/**
 * A local file reaches the widget through the app's file route, which only
 * exists behind a server. Point the resolver at a data: URL instead — `fetch`
 * reads those, so the markdown path runs exactly as it does in production
 * right down to the mermaid render, with nothing to stand up.
 */
type FileSrcWindow = { __tmuxyFileSrc?: (path: string) => string | undefined };

function widgetProps(src: string): WidgetProps {
  return {
    paneId: '%0',
    widgetName: 'browser',
    lines: [`__SRC__:${src}`],
    lastLine: `__SRC__:${src}`,
    rawContent: [],
    writeStdin: () => {},
    width: 80,
    height: 24,
  };
}

const meta: Meta<typeof TmuxyBrowser> = {
  title: 'Components/Widgets/TmuxyBrowser',
  component: TmuxyBrowser,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    const w = window as unknown as FileSrcWindow;
    w.__tmuxyFileSrc = (path) =>
      path.endsWith('.md')
        ? `data:text/markdown;charset=utf-8,${encodeURIComponent(MARKDOWN)}`
        : undefined;
    return () => {
      delete w.__tmuxyFileSrc;
    };
  },
};
export default meta;
type Story = StoryObj<typeof TmuxyBrowser>;

function Harness({ src }: { src: string }) {
  return (
    <ProviderHarness height={420}>
      <div style={{ width: 640, height: 420 }}>
        <TmuxyBrowser {...widgetProps(src)} />
      </div>
    </ProviderHarness>
  );
}

/** A markdown file is rendered, not framed — GFM tables and mermaid included. */
export const MarkdownFile: Story = {
  render: () => <Harness src="/tmp/release-notes.md" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = await waitFor(
      () => canvas.getByRole('heading', { level: 1, name: /release notes/i }),
      { timeout: 5000 },
    );
    // In the DOM is not enough: the widget nests three full-height boxes, and
    // a broken one clips the document to nothing.
    expect(heading.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(canvas.getByRole('cell', { name: 'prefix' })).toBeInTheDocument();
    await waitFor(
      () => {
        const svg = canvasElement.querySelector('.widget-mermaid svg');
        expect(svg).not.toBeNull();
        expect(svg!.getBoundingClientRect().width).toBeGreaterThan(0);
      },
      { timeout: 10000 },
    );
  },
};

/** An image source is drawn directly, scaled to fit the pane. */
export const ImageSource: Story = {
  render: () => <Harness src={PNG_DATA_URI} />,
  play: async ({ canvasElement }) => {
    const img = canvasElement.querySelector<HTMLImageElement>('.widget-browser-image img');
    expect(img).not.toBeNull();
    await waitFor(() => {
      expect(img!.complete).toBe(true);
      expect(img!.naturalWidth).toBeGreaterThan(0);
    });
    expect(img!.getBoundingClientRect().width).toBeGreaterThan(0);
  },
};

/**
 * A website is framed, and the pane shows the page and nothing else — the
 * widget contributes no toolbar, address bar or buttons of its own.
 */
export const WebPage: Story = {
  render: () => <Harness src="https://example.com/docs" />,
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLIFrameElement>('.widget-browser-frame');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('src')).toBe('https://example.com/docs');
    const rect = frame!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(100);
    expect(rect.height).toBeGreaterThan(100);
    // No chrome: the only controls on screen belong to the harness, not to
    // the widget's own subtree.
    expect(canvasElement.querySelectorAll('.widget-browser button').length).toBe(0);
  },
};
