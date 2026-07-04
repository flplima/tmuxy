import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { MermaidBlock } from './MermaidBlock';

const meta: Meta<typeof MermaidBlock> = {
  title: 'Components/Widgets/MermaidBlock',
  component: MermaidBlock,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720, background: '#0f0f12', padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof MermaidBlock>;

export const Flowchart: Story = {
  args: {
    chart: 'graph LR;\n  client[Browser] --> wasm[tmuxy-wasm];\n  wasm --> tmux[tmux 3.7a];',
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        const svg = canvasElement.querySelector('.widget-mermaid svg');
        expect(svg).not.toBeNull();
        expect(svg!.getBoundingClientRect().width).toBeGreaterThan(0);
        // The node labels come through into the rendered SVG text.
        expect(svg!.textContent).toContain('tmuxy-wasm');
      },
      { timeout: 10000 },
    );
  },
};

export const ParseError: Story = {
  args: {
    chart: 'graph TD;\n  A --> ;;; not mermaid at all {{{',
  },
  play: async ({ canvasElement }) => {
    // Invalid charts surface the parser error instead of an empty container.
    await waitFor(
      () => {
        const error = canvasElement.querySelector('.widget-markdown-error');
        expect(error).not.toBeNull();
        expect(error!.textContent).not.toHaveLength(0);
      },
      { timeout: 10000 },
    );
  },
};
