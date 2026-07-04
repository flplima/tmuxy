import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
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
