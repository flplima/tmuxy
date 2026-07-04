/**
 * Image protocol stories.
 *
 * tmuxy-core parses three terminal image protocols — iTerm2 (OSC 1337),
 * Kitty Graphics (APC _G), and Sixel (DCS Pq) — into `ImagePlacement`
 * records that flow through ServerPane.images to Terminal.tsx.
 *
 * These stories bypass the parser and feed placements directly via the
 * DemoAdapter's `tmuxy-image-attach` command (a storybook-only helper).
 * Terminal.tsx normally fetches image bytes from `/api/images/...`; we
 * override that with `window.__tmuxyImageSrc` so each placement resolves
 * to a tiny data: URL drawn live with a canvas. End-to-end this exercises:
 *
 *   DemoAdapter command → DemoTmux state → AppMachine →
 *   transformServerState (snake → camel) → TerminalPane → Terminal img
 *
 * Real-image pipeline (Rust decoder → /api/images) is covered by the
 * Rust unit tests + the agent-browser E2E suite.
 */

import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

// ---------------------------------------------------------------------------
// Image source registry — story play functions register (paneId, imageId)
// → data URL pairs; the global resolver returns them.
// ---------------------------------------------------------------------------

const SRC_REGISTRY = new Map<string, string>();

function key(paneId: string, imageId: number): string {
  return `${paneId}#${imageId}`;
}

function installResolverOnce(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as {
    __tmuxyImageSrc?: (paneId: string, imageId: number) => string | undefined;
    __tmuxyImageSrcInstalled?: boolean;
  };
  if (w.__tmuxyImageSrcInstalled) return;
  w.__tmuxyImageSrcInstalled = true;
  w.__tmuxyImageSrc = (paneId, imageId) => SRC_REGISTRY.get(key(paneId, imageId));
}

/**
 * Draw a labeled rectangle and return it as a data URL. Used as stand-in
 * image bytes so each story renders something visually distinct.
 */
function makeLabeledImage(
  label: string,
  bg: string,
  fg: string,
  width = 240,
  height = 120,
): string {
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = fg;
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, height / 2);
  return canvas.toDataURL('image/png');
}

/** Register a data URL for (paneId, imageId) and return it. */
function registerImage(paneId: string, imageId: number, dataUrl: string): void {
  SRC_REGISTRY.set(key(paneId, imageId), dataUrl);
}

/** Run an initializer once per story render (before AppHarness mounts). */
function StoryInit({ run }: { run: () => void }): null {
  // useEffect runs *after* the harness mounts — but the AppMachine takes a
  // tick before any pane is reachable, so by the time Terminal.tsx queries
  // the resolver, the registry is already populated.
  useEffect(() => {
    run();
  }, [run]);
  // Run synchronously too, so SSR / first paint already has the source.
  run();
  return null;
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/ImageProtocols',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => {
      installResolverOnce();
      return <Story />;
    },
  ],
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

/** Wait until at least one image with the given protocol renders. */
async function waitForImage(protocol: 'iterm2' | 'kitty' | 'sixel'): Promise<HTMLImageElement> {
  return waitFor(
    () => {
      const img = document.querySelector(
        `img.terminal-image[data-protocol="${protocol}"]`,
      ) as HTMLImageElement | null;
      if (!img) throw new Error(`no image yet for protocol=${protocol}`);
      return img;
    },
    { timeout: 8000 },
  );
}

// ---------------------------------------------------------------------------
// iTerm2 inline image (OSC 1337)
// ---------------------------------------------------------------------------

export const ITerm2: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-image-attach %0 iterm2 1 30x10 2,4'],
  },
  parameters: {
    docs: {
      description: {
        story:
          'iTerm2 OSC 1337 inline image placement. The Rust parser decodes the base64 payload and stores it for `/api/images/<pane>/<id>`; this story stubs the byte source via window.__tmuxyImageSrc.',
      },
    },
  },
  decorators: [
    (StoryFn) => (
      <>
        <StoryInit
          run={() => registerImage('%0', 1, makeLabeledImage('iTerm2', '#1e3a8a', '#fff'))}
        />
        <StoryFn />
      </>
    ),
  ],
  play: async ({ canvasElement }) => {
    const img = await waitForImage('iterm2');
    expect(img.getAttribute('data-image-id')).toBe('1');
    // Positioned relative to the pane grid: row=2, col=4.
    expect(img.style.top).toContain('2 *');
    expect(img.style.left).toContain('4 *');
    // The Terminal exists in the DOM tree too — confirm we're actually
    // rendering inside the harness, not in a stray detached subtree.
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('terminal')).toBeTruthy();
  },
};

// ---------------------------------------------------------------------------
// Kitty Graphics Protocol (APC _G)
// ---------------------------------------------------------------------------

export const Kitty: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-image-attach %0 kitty 7 40x12 1,2'],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Kitty Graphics Protocol image (APC _G…\\\\). The Rust parser handles chunked transfers (m=1/m=0) and formats f=24/32/100 (PNG); this story renders a pre-decoded placement to verify the frontend path.',
      },
    },
  },
  decorators: [
    (StoryFn) => (
      <>
        <StoryInit
          run={() => registerImage('%0', 7, makeLabeledImage('Kitty', '#7c3aed', '#fff'))}
        />
        <StoryFn />
      </>
    ),
  ],
  play: async () => {
    const img = await waitForImage('kitty');
    expect(img.getAttribute('data-image-id')).toBe('7');
    // The override returned a data: URL, not the default /api/images/...
    expect(img.src.startsWith('data:image/')).toBe(true);
  },
};

// ---------------------------------------------------------------------------
// Sixel (DCS Pq)
// ---------------------------------------------------------------------------

export const Sixel: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-image-attach %0 sixel 3 35x14 3,6'],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Sixel image (DCS Pq…ST). icy_sixel decodes the bitmap into RGBA on the backend; we re-encode as PNG before serving. This story validates the rendering side once the placement has been published.',
      },
    },
  },
  decorators: [
    (StoryFn) => (
      <>
        <StoryInit
          run={() => registerImage('%0', 3, makeLabeledImage('Sixel', '#047857', '#fff'))}
        />
        <StoryFn />
      </>
    ),
  ],
  play: async () => {
    const img = await waitForImage('sixel');
    expect(img.getAttribute('data-image-id')).toBe('3');
    // Confirms snake_case width_cells → camelCase widthCells made it through
    // the camelize() transform — Terminal.tsx renders `calc(${img.widthCells}...)`.
    expect(img.style.width).toContain('35 *');
    expect(img.style.height).toContain('14 *');
  },
};

// ---------------------------------------------------------------------------
// Multiple protocols on the same pane
// ---------------------------------------------------------------------------

export const MultipleProtocols: Story = {
  args: {
    height: 600,
    initCommands: [
      'tmuxy-image-attach %0 iterm2 11 20x6 0,0',
      'tmuxy-image-attach %0 kitty 12 20x6 7,0',
      'tmuxy-image-attach %0 sixel 13 20x6 14,0',
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'A single pane carrying three placements at once — one per protocol — stacked vertically. Verifies the renderer handles a mixed-protocol image list without collisions.',
      },
    },
  },
  decorators: [
    (StoryFn) => (
      <>
        <StoryInit
          run={() => {
            registerImage('%0', 11, makeLabeledImage('iTerm2', '#1e3a8a', '#fff'));
            registerImage('%0', 12, makeLabeledImage('Kitty', '#7c3aed', '#fff'));
            registerImage('%0', 13, makeLabeledImage('Sixel', '#047857', '#fff'));
          }}
        />
        <StoryFn />
      </>
    ),
  ],
  play: async () => {
    await waitFor(
      () => {
        const images = document.querySelectorAll('img.terminal-image');
        expect(images.length).toBe(3);
      },
      { timeout: 8000 },
    );

    const protocols = Array.from(document.querySelectorAll('img.terminal-image')).map((el) =>
      el.getAttribute('data-protocol'),
    );
    expect(protocols).toContain('iterm2');
    expect(protocols).toContain('kitty');
    expect(protocols).toContain('sixel');

    // Each placement keeps its own id — no clobbering when several images
    // share a pane.
    const ids = Array.from(document.querySelectorAll('img.terminal-image'))
      .map((el) => el.getAttribute('data-image-id'))
      .sort();
    expect(ids).toEqual(['11', '12', '13']);
  },
};

// ---------------------------------------------------------------------------
// Image carried into a split — confirms multi-pane delivery
// ---------------------------------------------------------------------------

export const ImageInSplit: Story = {
  args: {
    height: 600,
    initCommands: [
      'split-window -h',
      // %1 is the new pane created by the horizontal split.
      'tmuxy-image-attach %1 kitty 21 30x10 1,2',
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Image attached to a non-active pane after a split. Verifies the placement follows the right pane (no leakage into the originating pane).',
      },
    },
  },
  decorators: [
    (StoryFn) => (
      <>
        <StoryInit
          run={() => registerImage('%1', 21, makeLabeledImage('Split', '#b45309', '#fff'))}
        />
        <StoryFn />
      </>
    ),
  ],
  play: async ({ canvasElement }) => {
    const img = await waitForImage('kitty');
    expect(img.getAttribute('data-image-id')).toBe('21');

    // Two panes total — the placement landed in one of them, not both.
    const canvas = within(canvasElement);
    await waitFor(() => {
      const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
      expect(panes.length).toBeGreaterThanOrEqual(2);
    });
    expect(document.querySelectorAll('img.terminal-image').length).toBe(1);
  },
};
