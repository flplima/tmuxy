import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { TmuxyMarkdown } from './TmuxyMarkdown';
import type { WidgetProps } from './index';

/** Minimal WidgetProps — the markdown widget only reads `lines`. */
function widgetProps(lines: string[]): WidgetProps {
  return {
    paneId: '%0',
    widgetName: 'markdown',
    lines,
    lastLine: lines[lines.length - 1] ?? '',
    rawContent: [],
    writeStdin: () => {},
    width: 80,
    height: 24,
  };
}

const meta: Meta<typeof TmuxyMarkdown> = {
  title: 'Components/Widgets/TmuxyMarkdown',
  component: TmuxyMarkdown,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720, background: '#0f0f12', color: '#e5e5e5', padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TmuxyMarkdown>;

export const InlineMarkdown: Story = {
  args: widgetProps([
    '# Release Notes',
    '',
    'Fixed a bug in `parseLayout` and added GFM tables:',
    '',
    '| Key | Action |',
    '| --- | ------ |',
    '| C-a | prefix |',
    '',
    '```bash',
    'tmuxy pane split -h',
    '```',
  ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('heading', { level: 1, name: /release notes/i })).toBeInTheDocument();
    // GFM table renders as a real table with the data cell.
    expect(canvas.getByRole('table')).toBeInTheDocument();
    expect(canvas.getByRole('cell', { name: 'prefix' })).toBeInTheDocument();
    // Inline code and fenced code get the widget-specific classes.
    expect(canvasElement.querySelector('.widget-markdown-inline-code')).not.toBeNull();
    expect(canvasElement.querySelector('.widget-markdown-pre')).not.toBeNull();
  },
};

export const MermaidFence: Story = {
  args: widgetProps(['```mermaid', 'graph TD;', '  A[Start] --> B[End];', '```']),
  play: async ({ canvasElement }) => {
    // A ```mermaid fence routes to MermaidBlock, which renders an SVG async.
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

export const WaitingForContent: Story = {
  args: widgetProps([]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/waiting for content/i)).toBeInTheDocument();
  },
};
