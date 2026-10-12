import type { Meta, StoryObj } from '@storybook/react-vite';
import { PaneId } from '../../../domain/ids';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TmuxyBrowser } from './TmuxyBrowser';
import { ProviderHarness } from '../../../stories/StoryHarness';
import { luminance, rampTables, readThemeRamp } from '../../../utils/themeColorFilter';
import { browserWidget } from './definition';
import type { AppMachineContext } from '../../../machines/types';
import type { WidgetProps } from '../index';

// 1×1 opaque PNG, small enough to embed and decode instantly.
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A page with a real `<title>`, for the pane-naming path. */
const HTML_PAGE =
  '<!doctype html><html><head><title>Release &mdash; notes</title></head>' +
  '<body><h1>PAGE BODY</h1></body></html>';

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
    paneId: PaneId.make('%0'),
    lines: [...(colorFilter ? ['__COLOR_FILTER__'] : []), `__SRC__:${src}`],
  };
}

const meta: Meta<typeof TmuxyBrowser> = {
  title: 'Components/Widgets/TmuxyBrowser',
  component: TmuxyBrowser,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    const w = window as unknown as FileSrcWindow;
    w.__tmuxyFileSrc = (path) => {
      if (path.endsWith('.md')) {
        return `data:text/markdown;charset=utf-8,${encodeURIComponent(MARKDOWN)}`;
      }
      if (path.endsWith('.html')) {
        return `data:text/html;charset=utf-8,${encodeURIComponent(HTML_PAGE)}`;
      }
      return undefined;
    };
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
 * A local page is framed under the address bar, and the bar costs the page one
 * row — the rest of the pane is the page.
 */
export const LocalPage: Story = {
  render: () => <Harness src="/tmp/docs.html" />,
  play: async ({ canvasElement }) => {
    const frame = await waitFor(() => {
      const el = canvasElement.querySelector<HTMLIFrameElement>('.widget-browser-frame');
      expect(el).not.toBeNull();
      return el!;
    });
    const rect = frame.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(100);
    expect(rect.height).toBeGreaterThan(100);

    // The bar sits above the page, spans it, and takes one row of it.
    const nav = canvasElement.querySelector<HTMLElement>('[data-testid="browser-nav"]')!;
    expect(nav).not.toBeNull();
    const navRect = nav.getBoundingClientRect();
    expect(navRect.bottom).toBeLessThanOrEqual(rect.top + 1);
    expect(Math.round(navRect.width)).toBe(Math.round(rect.width));
    expect(navRect.height).toBeLessThan(32);
  },
};

/**
 * A website is never framed: most refuse to be, and WebKit shows the refusal
 * as a blank pane. The widget hands the pane to `tmuxy browser` instead and
 * says so while that happens.
 */
export const WebsiteGoesToTheBrowserPane: Story = {
  render: () => <Harness src="https://example.com/docs" />,
  play: async ({ canvasElement }) => {
    const note = await waitFor(() => {
      const el = canvasElement.querySelector<HTMLElement>('[data-testid="browser-opening-live"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(note.textContent).toContain('https://example.com/docs');
    expect(note.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(canvasElement.querySelector('.widget-browser-frame')).toBeNull();
  },
};

/**
 * The address bar: type somewhere new, and back/forward walk the places this
 * pane has been pointed. A framed document's own links are not in that
 * history — nothing inside the frame can be read from out here.
 */
export const NavigatingWithTheAddressBar: Story = {
  render: () => <Harness src="/tmp/docs.html" />,
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    const nav = canvasElement.querySelector<HTMLElement>('[data-testid="browser-nav"]')!;
    const input = nav.querySelector<HTMLInputElement>('[data-testid="browser-nav-input"]')!;
    const back = nav.querySelector<HTMLButtonElement>('[data-testid="browser-nav-back"]')!;
    const forward = nav.querySelector<HTMLButtonElement>('[data-testid="browser-nav-forward"]')!;
    const external = nav.querySelector<HTMLButtonElement>('[data-testid="browser-nav-external"]')!;

    // Where the pane was pointed, and nowhere to step from it.
    expect(input.value).toBe('/tmp/docs.html');
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);
    // A local file is not something the system browser can be handed.
    expect(external.disabled).toBe(true);

    // Type an address and press Enter.
    await user.click(input);
    await user.clear(input);
    await user.type(input, '/tmp/next.html{Enter}');
    await waitFor(() => {
      expect(input.value).toBe('/tmp/next.html');
    });
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);

    // Back returns to where the pane started, and forward comes back.
    await user.click(back);
    await waitFor(() => {
      expect(input.value).toBe('/tmp/docs.html');
    });
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(false);

    await user.click(forward);
    await waitFor(() => {
      expect(input.value).toBe('/tmp/next.html');
    });
    expect(canvasElement.querySelector('.widget-browser-frame')).not.toBeNull();
  },
};

/**
 * A local file is shown the same way, but it is not something the system
 * browser can be handed — so that one button says so instead of doing nothing.
 */
export const LocalPageCannotBeOpenedExternally: Story = {
  render: () => <Harness src="/tmp/release-notes.md" />,
  play: async ({ canvasElement }) => {
    const external = await waitFor(() => {
      const el = canvasElement.querySelector<HTMLButtonElement>(
        '[data-testid="browser-nav-external"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    expect(external.disabled).toBe(true);
    const input = canvasElement.querySelector<HTMLInputElement>(
      '[data-testid="browser-nav-input"]',
    )!;
    expect(input.value).toBe('/tmp/release-notes.md');
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

    // The ramp is the theme's, read live — and it runs DARKEST FIRST, which
    // is what makes the filter keep a page's polarity: luminance 0 (full
    // black in the page) lands on the theme's darkest tone, not on its
    // foreground. Mapping by role instead inverted every page on a dark
    // theme, so a black website came back light.
    const ramp = readThemeRamp();
    expect(ramp).not.toBeNull();
    expect(luminance(ramp![0])).toBeLessThan(luminance(ramp![ramp!.length - 1]));
    const want = rampTables(ramp!);
    expect(svgFilter.querySelector('feFuncR')!.getAttribute('tableValues')).toBe(want.r);
    expect(svgFilter.querySelector('feFuncG')!.getAttribute('tableValues')).toBe(want.g);
    expect(svgFilter.querySelector('feFuncB')!.getAttribute('tableValues')).toBe(want.b);

    const plain = canvasElement.querySelector<HTMLImageElement>('[data-testid="plain"] img')!;
    expect(getComputedStyle(plain).filter).toBe('none');
  },
};

/**
 * A pane showing a page is named after the PAGE, not its address — the same
 * thing a browser tab does. The title is read by fetching the HTML, which the
 * app may do for a local file (its own route serves it) but not for a
 * cross-origin site, whose document is not the app's to read; see
 * `pageTitle.ts`.
 */
export const PaneIsNamedAfterThePage: Story = {
  render: () => <Harness src="/tmp/release.html" />,
  play: async () => {
    const app = (
      window as unknown as {
        app: { getSnapshot(): { context: AppMachineContext } };
      }
    ).app;
    const lines = ['__SRC__:/tmp/release.html'];

    // The title arrives from a fetch, so it lands a moment after the frame.
    await waitFor(
      () => {
        expect(
          browserWidget.selectTitle?.(app.getSnapshot().context, PaneId.make('%0'), lines),
        ).toBe('Release — notes');
      },
      { timeout: 8000 },
    );
  },
};
