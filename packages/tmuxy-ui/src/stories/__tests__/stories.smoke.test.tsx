/**
 * Smoke test for stories.
 *
 * Two tiers:
 *   1. Pure-component stories (no AppProvider) are mounted via
 *      composeStories so we catch real render errors.
 *   2. Stories backed by ProviderHarness or AppHarness drive the full
 *      XState machine + DemoAdapter. Those depend on real browser layout
 *      and an animation loop that doesn't terminate in jsdom — mounting
 *      them here exhausts the v8 heap. We only verify the modules import
 *      cleanly and composeStories returns callable components.
 *
 * The full play function for App.Interactive is meant to be exercised by
 * the Storybook test runner in a real browser (Chromium via CDP) or via
 * `npm run storybook` for manual review.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { composeStories, setProjectAnnotations } from '@storybook/react';
import type { ComponentType } from 'react';

// composeStories needs the meta + named exports; the type is a bit ceremony,
// so we widen it to `any` once and cast in the loop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoryModule = any;

import * as previewAnnotations from '../../../.storybook/preview';

// Pure-component stories (no AppContext needed)
import * as ConnectionStatusStories from '../../components/ConnectionStatus.stories';
import * as ModalStories from '../../components/Modal.stories';
import * as CursorStories from '../../components/Cursor.stories';
import * as TerminalLineStories from '../../components/TerminalLine.stories';
import * as TmuxyMarkdownStories from '../../components/widgets/TmuxyMarkdown.stories';
import * as MermaidBlockStories from '../../components/widgets/MermaidBlock.stories';
import * as TmuxyImageStories from '../../components/widgets/TmuxyImage.stories';

// Provider-backed stories (need the full machine + DemoAdapter)
import * as StatusBarStories from '../../components/StatusBar.stories';
import * as WindowTabsStories from '../../components/WindowTabs.stories';
import * as TmuxStatusBarStories from '../../components/TmuxStatusBar.stories';
import * as PaneHeaderStories from '../../components/PaneHeader.stories';
import * as FloatPaneStories from '../../components/FloatPane.stories';
import * as ImageProtocolsStories from '../../components/ImageProtocols.stories';
import * as AppMenuStories from '../../components/menus/AppMenu.stories';
import * as PaneContextMenuStories from '../../components/PaneContextMenu.stories';
import * as ResizeDividersStories from '../../components/ResizeDividers.stories';
// App/Application is now driven by real tmux (v86 + WASM) and can't boot in
// jsdom — it's a `v86` story exercised by a dedicated browser e2e instead.

beforeAll(() => {
  setProjectAnnotations([previewAnnotations.default]);

  // jsdom doesn't ship ResizeObserver; polyfill with a no-op so AppContext's
  // sizeActor can subscribe without throwing during smoke tests.
  if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
    class NoopResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver =
      NoopResizeObserver;
  }

  // jsdom doesn't implement document.fonts (FontFaceSet); sizeActor reads
  // document.fonts.ready to re-measure after webfont load. Provide a stub
  // that resolves immediately so the actor's then-handler still fires.
  if (typeof document !== 'undefined' && !document.fonts) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

afterEach(() => {
  cleanup();
});

const PURE_STORY_MODULES: Record<string, StoryModule> = {
  ConnectionStatus: ConnectionStatusStories,
  Modal: ModalStories,
  Cursor: CursorStories,
  TerminalLine: TerminalLineStories,
  TmuxyMarkdown: TmuxyMarkdownStories,
  MermaidBlock: MermaidBlockStories,
  TmuxyImage: TmuxyImageStories,
};

const PROVIDER_STORY_MODULES: Record<string, StoryModule> = {
  StatusBar: StatusBarStories,
  WindowTabs: WindowTabsStories,
  TmuxStatusBar: TmuxStatusBarStories,
  PaneHeader: PaneHeaderStories,
  FloatPane: FloatPaneStories,
  ImageProtocols: ImageProtocolsStories,
  AppMenu: AppMenuStories,
  PaneContextMenu: PaneContextMenuStories,
  ResizeDividers: ResizeDividersStories,
};

describe('Pure component stories', () => {
  for (const [name, mod] of Object.entries(PURE_STORY_MODULES)) {
    describe(name, () => {
      const composed = composeStories(mod);
      for (const [storyName, Story] of Object.entries(composed)) {
        it(`renders ${storyName} without throwing`, () => {
          const Component = Story as ComponentType;
          expect(() => render(<Component />)).not.toThrow();
        });
      }
    });
  }
});

describe('Provider/App story module import sanity', () => {
  // These stories need live providers/adapters, so they can't be rendered
  // here — composeStories() itself throws on malformed story exports, and
  // the count assertion catches an accidentally emptied module. (A per-story
  // `typeof Story === 'function'` loop used to run here, but it could not
  // fail once composeStories succeeded — pure noise.)
  for (const [name, mod] of Object.entries(PROVIDER_STORY_MODULES)) {
    it(`${name} composes with at least one story`, () => {
      const composed = composeStories(mod);
      expect(Object.keys(composed).length).toBeGreaterThan(0);
    });
  }
});
