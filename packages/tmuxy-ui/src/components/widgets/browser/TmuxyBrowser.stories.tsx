import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { TmuxyBrowser } from './TmuxyBrowser';
import { ProviderHarness } from '../../../stories/StoryHarness';
import { rampTables, readThemeRamp } from '../../../utils/themeColorFilter';
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

function widgetProps(src: string, colorFilter = false): WidgetProps {
  return {
    paneId: '%0',
    widgetName: 'browser',
    lines: [...(colorFilter ? ['__COLOR_FILTER__'] : []), `__SRC__:${src}`],
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

function Harness({ src, colorFilter = false }: { src: string; colorFilter?: boolean }) {
  return (
    <ProviderHarness height={420}>
      <div style={{ width: 640, height: 420 }}>
        <TmuxyBrowser {...widgetProps(src, colorFilter)} />
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

/**
 * `--color-filter`: the image is drawn through a filter that maps its
 * luminance onto the theme's foreground → gray → background ramp. Without the
 * flag the same image is drawn as it is.
 */
export const ColorFilterRecoloursAnImage: Story = {
  render: () => (
    <div style={{ display: 'flex' }}>
      <div data-testid="filtered">
        <Harness src={PNG_DATA_URI} colorFilter />
      </div>
      <div data-testid="plain">
        <Harness src={PNG_DATA_URI} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const filtered = await waitFor(() => {
      const img = canvasElement.querySelector<HTMLImageElement>('[data-testid="filtered"] img');
      expect(img).not.toBeNull();
      return img!;
    });
    const svgFilter = await waitFor(() => {
      const el = canvasElement.querySelector<SVGFilterElement>('[data-testid="filtered"] filter');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(getComputedStyle(filtered).filter).toContain(`#${svgFilter.id}`);

    // The ramp is the theme's, read live.
    const ramp = readThemeRamp();
    expect(ramp).not.toBeNull();
    const want = rampTables(ramp!);
    expect(svgFilter.querySelector('feFuncR')!.getAttribute('tableValues')).toBe(want.r);
    expect(svgFilter.querySelector('feFuncG')!.getAttribute('tableValues')).toBe(want.g);
    expect(svgFilter.querySelector('feFuncB')!.getAttribute('tableValues')).toBe(want.b);

    const plain = canvasElement.querySelector<HTMLImageElement>('[data-testid="plain"] img')!;
    expect(getComputedStyle(plain).filter).toBe('none');
  },
};
