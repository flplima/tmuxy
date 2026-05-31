import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { RichContent, RichContentLine } from './RichContent';
import type { RichContent as RichContentType } from '../utils/richContentParser';

const meta: Meta<typeof RichContent> = {
  title: 'Components/RichContent',
  component: RichContent,
  parameters: { layout: 'centered' },
};
export default meta;
type Story = StoryObj<typeof RichContent>;

export const PlainText: Story = {
  args: {
    content: { type: 'text', content: 'a plain terminal segment with no escapes' },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/plain terminal segment/i)).toBeInTheDocument();
  },
};

export const Hyperlink: Story = {
  args: {
    content: {
      type: 'hyperlink',
      url: 'https://tmuxy.dev',
      text: 'tmuxy.dev',
      id: 'link-1',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: /tmuxy\.dev/i });
    expect(link).toHaveAttribute('href', 'https://tmuxy.dev');
  },
};

export const Image: Story = {
  args: {
    content: {
      type: 'image',
      protocol: 'iterm2',
      data: 'https://placehold.co/200x100/2a2a32/ffffff/png?text=iTerm2',
      alt: 'placeholder image',
      width: '200',
      height: '100',
      preserveAspectRatio: true,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The image renders into the DOM even before it loads from the network.
    const img = canvas.getByAltText('placeholder image') as HTMLImageElement;
    expect(img).toBeInTheDocument();
  },
};

const lineContents: RichContentType[] = [
  { type: 'text', content: 'mixed line: ' },
  { type: 'hyperlink', url: 'https://example.com', text: 'click here' },
  { type: 'text', content: ' — and then more text' },
];

export const Mixed: StoryObj<typeof RichContentLine> = {
  render: () => <RichContentLine contents={lineContents} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/mixed line:/i)).toBeInTheDocument();
    expect(canvas.getByRole('link', { name: /click here/i })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(canvas.getByText(/and then more text/i)).toBeInTheDocument();
  },
};
