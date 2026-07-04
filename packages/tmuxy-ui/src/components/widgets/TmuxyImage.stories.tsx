import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { TmuxyImage } from './TmuxyImage';
import type { WidgetProps } from './index';

// 1×1 opaque PNG, small enough to embed and decode instantly.
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Minimal WidgetProps — the image widget only reads `lines`. */
function widgetProps(lines: string[]): WidgetProps {
  return {
    paneId: '%0',
    widgetName: 'image',
    lines,
    lastLine: lines[lines.length - 1] ?? '',
    rawContent: [],
    writeStdin: () => {},
    width: 80,
    height: 24,
  };
}

const meta: Meta<typeof TmuxyImage> = {
  title: 'Components/Widgets/TmuxyImage',
  component: TmuxyImage,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ width: 400, height: 300, background: '#0f0f12' }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TmuxyImage>;

export const DataUri: Story = {
  args: widgetProps([PNG_DATA_URI]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const img = canvas.getByAltText<HTMLImageElement>('Widget image');
    expect(img.src).toContain('data:image/png;base64,');
    await waitFor(() => {
      expect(img.complete).toBe(true);
      expect(img.naturalWidth).toBeGreaterThan(0);
    });
  },
};

export const WrappedDataUri: Story = {
  // Terminal line wrapping splits a long URI mid-string; the widget joins
  // lines without separators and must reassemble the exact same URI.
  args: widgetProps([PNG_DATA_URI.slice(0, 60), PNG_DATA_URI.slice(60)]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const img = canvas.getByAltText<HTMLImageElement>('Widget image');
    expect(img.src).toBe(PNG_DATA_URI);
    await waitFor(() => {
      expect(img.complete).toBe(true);
      expect(img.naturalWidth).toBeGreaterThan(0);
    });
  },
};

export const WaitingForImage: Story = {
  args: widgetProps(['no image here, just shell noise']),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/waiting for image/i)).toBeInTheDocument();
    expect(canvasElement.querySelector('img')).toBeNull();
  },
};
