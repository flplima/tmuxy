import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, fireEvent } from 'storybook/test';
import { ResizeDividers } from './ResizeDividers';
import { ProviderHarness } from '../stories/StoryHarness';
import { useAppSelector, selectVisiblePanes } from '../machines/AppContext';

const CHAR_W = 8;
const CHAR_H = 16;

/**
 * Feeds the live pane geometry from the demo engine into ResizeDividers, the
 * same way PaneLayout does in the app — so divider positions come from real
 * layout data instead of hand-built pane literals that drift from the type.
 */
function LiveDividers() {
  const panes = useAppSelector(selectVisiblePanes);
  return (
    <div style={{ position: 'relative', width: 800, height: 400 }}>
      <ResizeDividers
        panes={panes}
        charWidth={CHAR_W}
        charHeight={CHAR_H}
        centeringOffset={{ x: 0, y: 0 }}
      />
    </div>
  );
}

const meta: Meta<typeof ResizeDividers> = {
  title: 'Components/ResizeDividers',
  component: ResizeDividers,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof ResizeDividers>;

export const VerticalDivider: Story = {
  render: () => (
    <ProviderHarness height={420} initCommands={['split-window -h']}>
      <LiveDividers />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const divider = await waitFor(
      () => {
        const el = canvasElement.querySelector<HTMLElement>('.resize-divider');
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 5000 },
    );

    // Side-by-side panes get one vertical (ew-resize) divider spanning the
    // shared edge with a real hit area.
    expect(canvasElement.querySelectorAll('.resize-divider')).toHaveLength(1);
    expect(divider.style.cursor).toBe('ew-resize');
    const rect = divider.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(CHAR_H);
  },
};

export const MixedOrientations: Story = {
  render: () => (
    <ProviderHarness height={420} initCommands={['split-window -h', 'split-window -v']}>
      <LiveDividers />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    // Three panes (left + right split into top/bottom) produce N-1 = 2
    // dividers: one per orientation.
    await waitFor(
      () => {
        const dividers = [...canvasElement.querySelectorAll<HTMLElement>('.resize-divider')];
        expect(dividers).toHaveLength(2);
        const cursors = dividers.map((d) => d.style.cursor).sort();
        expect(cursors).toEqual(['ew-resize', 'ns-resize']);
      },
      { timeout: 5000 },
    );
  },
};

/**
 * A fully collapsed stack: every row down to the single line a collapsed pane
 * draws. The demo engine clamps its splits well above that, so the geometry is
 * derived from the live panes and squashed — the layout is a real one (it is
 * what stacked panes look like with the focus on another row), just not one
 * the demo can reach on its own.
 */
function CollapsedStackDividers() {
  const panes = useAppSelector(selectVisiblePanes);
  const squashed = panes.map((p, i) => ({ ...p, x: 0, y: i * 2, width: 80, height: 1 }));
  return (
    <div style={{ position: 'relative', width: 800, height: 400 }}>
      <ResizeDividers
        panes={squashed}
        charWidth={CHAR_W}
        charHeight={CHAR_H}
        centeringOffset={{ x: 0, y: 0 }}
      />
    </div>
  );
}

export const PinnedDividerRefusesTheDrag: Story = {
  render: () => (
    <ProviderHarness height={420} initCommands={['split-window -v', 'split-window -v']}>
      <CollapsedStackDividers />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Between two rows that are already one line tall there is nothing to give on either side, so tmux would refuse any resize. The divider says so — the not-allowed cursor, and marked disabled for anything reading the page — and swallows the press instead of starting a drag whose every frame would be thrown away.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dividers = await waitFor(
      () => {
        const found = [...canvasElement.querySelectorAll<HTMLElement>('.resize-divider')];
        expect(found.length).toBeGreaterThan(0);
        return found;
      },
      { timeout: 5000 },
    );

    for (const divider of dividers) {
      expect(divider).toHaveClass('resize-divider-locked');
      expect(divider.style.cursor).toBe('not-allowed');
      expect(divider).toHaveAttribute('aria-disabled', 'true');
      // Still a real target — it has to be, or the cursor would never show.
      const rect = divider.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }

    // Pressing one starts nothing: no resize state reaches the machine, so the
    // grid never takes the class it wears while a drag is live.
    const first = dividers[0];
    const box = first.getBoundingClientRect();
    fireEvent.mouseDown(first, {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      button: 0,
      bubbles: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector('.pane-layout-resizing')).toBeNull();
    fireEvent.mouseUp(document.body);
  },
};
