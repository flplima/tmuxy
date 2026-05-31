import type { Preview } from '@storybook/react-vite';
import '../src/styles.css';
import '../src/fonts/nerd-font.css';
import '../src/components/widgets/init';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'tmuxy',
      values: [
        { name: 'tmuxy', value: '#0f0f12' },
        { name: 'light', value: '#f5f5f5' },
      ],
    },
    layout: 'fullscreen',
  },
};

export default preview;
